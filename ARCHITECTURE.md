# Event-Driven Architecture

## Overview

The system uses native Linux `inotifywait` to watch two directories:

- `/books` — source files (books and folders)
- `/data` — generated metadata (entry.xml, feed.xml, covers)

Events are sent via HTTP to the server's EffectTS queue for sequential processing.

## System Architecture

```mermaid
flowchart TB
    subgraph Sources["/books (Source Files)"]
        B[Books: .epub, .fb2, .pdf, ...]
        F[Folders]
    end

    subgraph Data["/data (Generated Metadata)"]
        EX[entry.xml]
        UEX[_entry.xml]
        FX[feed.xml]
        COV[cover.jpg / thumb.jpg]
    end

    subgraph Watchers["watcher.sh (inotifywait)"]
        BW["/books watcher<br/>CREATE, CLOSE_WRITE, DELETE,<br/>MOVED_FROM, MOVED_TO"]
        DW["/data watcher<br/>CLOSE_WRITE, MOVED_TO"]
    end

    subgraph Server["server.ts"]
        EP["POST /events"]
        RS["POST /resync"]
        Q["EffectTS Queue<br/>(unbounded)"]
        R["Event Router"]
    end

    Sources --> BW
    Data --> DW
    BW -->|curl POST| EP
    DW -->|curl POST| EP
    EP --> Q
    Q --> R
```

## Components

### watcher.sh

- Runs `inotifywait` for `/books` and `/data` directories
- Sends JSON events via `curl` to `POST /events`
- Knows only about `$SERVER_URL` — no coupling to server internals

### server.ts

- HTTP server with EffectTS Queue
- Runs initial sync on startup
- `POST /events` — receives events from watchers
- `GET /health` — queue stats + server state
- Sequential event processing via Queue consumer

### EffectTS Queue

- `Queue.unbounded<FileEvent>()` — no capacity limit
- FIFO processing — events handled sequentially
- Replaces debouncer — queue serializes naturally
- `clearQueue()` helper for /resync endpoint

### Effect Handlers (DI-based)

All handlers use Effect with dependency injection for testability:

```typescript
export const bookSync = (parent: string, name: string) =>
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const logger = yield* LoggerService;
    const fs = yield* FileSystemService;
    // ... handler logic
  });
```

## Event Flow

```mermaid
flowchart LR
    subgraph Events
      subgraph BookEvents["Book Events"]
          BA[Book Created/Changed]
          BD[Book Deleted]
      end

      subgraph FolderEvents["Folder Events"]
          FA[Folder Created/Changed]
          FD[Folder Deleted]
      end

      subgraph XMLEvents["XML Events (/data watcher)"]
          BX[entry.xml Changed]
          FX[_entry.xml Changed]
      end
    end

    subgraph Handlers["Effect Handlers"]
        BS[book-sync.ts]
        BC[book-cleanup.ts]
        FS[folder-sync.ts]
        FC[folder-cleanup.ts]
        FMS[folder-meta-sync.ts]
        PMS[parent-meta-sync.ts]
    end

    subgraph Artifacts["Intermediate Artifacts"]
        E[entry.xml]
        UE[_entry.xml]
        C[cover.jpg]
        T[thumb.jpg]
    end

    subgraph Result["Result Artifacts"]
        F[feed.xml]
    end

    BA --> BS
    BD --> BC
    FA --> FS
    FD --> FC

    BS --> E
    BS --> C
    BS --> T
    FS --> UE

    BD -.->|parent folder changed| FA
    FD -.->|parent folder changed| FA

    E -.-> BX
    UE -.-> FX

    BX --> PMS
    FX --> FMS
    FX --> PMS

    FMS --> F
    PMS --> FMS
```

## Handlers Reference

| Handler               | Trigger                           | Input                  | Output                                         | Notes                                  |
| --------------------- | --------------------------------- | ---------------------- | ---------------------------------------------- | -------------------------------------- |
| `book-sync.ts`        | Book CREATE/CLOSE_WRITE/MOVED_TO  | `/books/path/book.ext` | `entry.xml`, `cover.jpg`, `thumb.jpg`, symlink | Extracts metadata via format handlers  |
| `book-cleanup.ts`     | Book DELETE/MOVED_FROM            | `/books/path/book.ext` | Removes `/data/path/book.ext/`                 | Recursive delete                       |
| `folder-sync.ts`      | Folder CREATE/MOVED_TO (ISDIR)    | `/books/path/folder/`  | `_entry.xml`                                   | Counts subfolders and books            |
| `folder-cleanup.ts`   | Folder DELETE/MOVED_FROM (ISDIR)  | `/books/path/folder/`  | Removes `/data/path/folder/`                   | Recursive delete                       |
| `folder-meta-sync.ts` | `_entry.xml` CLOSE_WRITE/MOVED_TO | `/data/path/folder/`   | `feed.xml`                                     | Collects all entry.xml and \_entry.xml |
| `parent-meta-sync.ts` | `entry.xml` CLOSE_WRITE/MOVED_TO  | `/data/path/book/`     | Triggers `folder-meta-sync` for parent         | Delegation only                        |

## Artifact Structure

```
/data/
├── feed.xml                      # Root catalog feed
├── Fiction/
│   ├── _entry.xml                # Folder entry (for parent's feed.xml)
│   ├── feed.xml                  # Folder's feed (lists books + subfolders)
│   └── book.epub/
│       ├── entry.xml             # Book entry (for parent's feed.xml)
│       ├── cover.jpg             # Full-size cover
│       ├── thumb.jpg             # Thumbnail
│       └── file                  # Symlink → /books/Fiction/book.epub
└── Comics/
    ├── _entry.xml
    ├── feed.xml
    └── ...
```

## Event Routing Logic

```typescript
// /books watcher routing
if (ISDIR flag) {
  DELETE/MOVED_FROM → folder-cleanup.ts
  CREATE/MOVED_TO   → folder-sync.ts
} else if (BOOK_EXTENSION) {
  DELETE/MOVED_FROM → book-cleanup.ts
  CREATE/CLOSE_WRITE/MOVED_TO → book-sync.ts
}

// /data watcher routing
if (name === "entry.xml") {
  → parent-meta-sync.ts
}
if (name === "_entry.xml") {
  → folder-meta-sync.ts
  → parent-meta-sync.ts (also)
}
// feed.xml events are ignored (loop prevention)
```

## Startup Sequence

```mermaid
sequenceDiagram
    participant D as Dockerfile CMD
    participant S as server.ts
    participant W as watcher.sh
    participant Q as Queue Consumer
    participant BW as /books watcher
    participant DW as /data watcher

    D->>S: Start server (background)
    S->>S: Initialize EffectTS Queue
    S->>Q: Fork queue consumer (background)
    S->>S: Start HTTP server

    D->>W: Start watcher.sh
    W->>W: Wait for server /health (HTTP response)
    W->>BW: Start /books watcher (background)
    W->>DW: Start /data watcher (background)

    S->>S: Run initialSync
    S->>S: Scan /books, create sync plan
    S->>Q: Enqueue BookCreated/FolderCreated events
    Q->>Q: Process events → handlers → entry.xml
    DW->>S: POST /events (EntryXmlChanged)
    Q->>Q: parentMetaSync → folderMetaSync → feed.xml

    Note over S,Q: Cascading feed generation via watcher
```

## Docker Entry Points

| Mode            | Command                                             | Description             |
| --------------- | --------------------------------------------------- | ----------------------- |
| **Production**  | `sh -c "bun run src/server.ts & sh src/watcher.sh"` | Server + watchers       |
| **Development** | `bun run --watch src/server.ts`                     | Server only, hot reload |
| **Test**        | `bun test`                                          | Unit/integration tests  |

## Loop Prevention

| Event        | Watched? | Reason                                  |
| ------------ | -------- | --------------------------------------- |
| `entry.xml`  | Yes      | Triggers parent feed regeneration       |
| `_entry.xml` | Yes      | Triggers own + parent feed regeneration |
| `feed.xml`   | No       | Would cause infinite loop               |
| `*.tmp`      | No       | Intermediate files                      |
| `cover.jpg`  | No       | No cascade needed                       |
| `thumb.jpg`  | No       | No cascade needed                       |

## Atomic Writes

All XML files use atomic write pattern to prevent partial reads:

```typescript
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await Bun.write(tmpPath, content);
  await rename(tmpPath, path); // Atomic on POSIX
}
```

This triggers `MOVED_TO` instead of `CLOSE_WRITE` in inotify.

## Testing

EffectTS DI enables easy unit testing with mock services:

```typescript
const TestLayer = Layer.mergeAll(
  TestConfigService, // fake paths
  TestLoggerService, // silent or capture
  TestFileSystemService, // mock fs operations
);

const effect = bookCleanup("/test/books/Fiction", "book.epub");
await Effect.runPromise(Effect.provide(effect, TestLayer));

expect(mockFs.rmCalls).toHaveLength(1);
```
