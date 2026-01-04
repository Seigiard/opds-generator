# Event-Driven Architecture Schema

## Overview

The system uses native Linux `inotifywait` to watch two directories:

- `/books` — source files (books and folders)
- `/data` — generated metadata (entry.xml, feed.xml, covers)

Events flow through a TypeScript debouncer that batches and routes them to appropriate handlers.

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

    subgraph Watchers["inotifywait Watchers"]
        BW["/books watcher<br/>CREATE, CLOSE_WRITE, DELETE,<br/>MOVED_FROM, MOVED_TO"]
        DW["/data watcher<br/>CLOSE_WRITE, MOVED_TO"]
    end

    subgraph Debouncer["debouncer.ts"]
        BD[Books Debouncer<br/>500ms idle / 5s max]
        DD[Data Debouncer<br/>500ms idle / 5s max]
    end

    Sources --> BW
    Data --> DW
    BW --> BD
    DW --> DD
```

## Event Flow

```mermaid
---
config:
  layout: elk
---
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

    subgraph Handlers["Event Handlers"]
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

## Event Cascade Examples

### Adding a Book

```mermaid
sequenceDiagram
    participant U as User
    participant BA as Book Created
    participant BS as book-sync.ts
    participant E as entry.xml
    participant BX as entry.xml Changed
    participant PMS as parent-meta-sync.ts
    participant FMS as folder-meta-sync.ts
    participant F as feed.xml

    U->>BA: Copy book.epub to /books/Fiction/
    BA->>BS: trigger
    BS->>BS: Extract metadata
    BS->>BS: Generate cover.jpg, thumb.jpg
    BS->>E: Create (atomic write)
    E->>BX: /data watcher detects
    BX->>PMS: trigger
    PMS->>FMS: delegate to parent folder
    FMS->>F: Regenerate (atomic write)
    Note over F: feed.xml changes are ignored
```

### Deleting a Book

```mermaid
sequenceDiagram
    participant U as User
    participant BD as Book Deleted
    participant BC as book-cleanup.ts
    participant FA as Folder Changed
    participant FS as folder-sync.ts
    participant UE as _entry.xml
    participant FX as _entry.xml Changed
    participant FMS as folder-meta-sync.ts
    participant PMS as parent-meta-sync.ts
    participant F as feed.xml

    U->>BD: Delete book.epub from /books/Fiction/
    BD->>BC: trigger
    BC->>BC: rm -rf /data/Fiction/book.epub/
    BD->>FA: parent folder changed
    FA->>FS: trigger
    FS->>UE: Update bookCount (atomic write)
    UE->>FX: /data watcher detects
    FX->>FMS: trigger
    FMS->>F: Regenerate (atomic write)
    FX->>PMS: trigger
    PMS->>FMS: delegate to parent folder
    FMS->>F: Regenerate parent (atomic write)
```

### Creating a Folder

```mermaid
sequenceDiagram
    participant U as User
    participant FA as Folder Created
    participant FS as folder-sync.ts
    participant UE as _entry.xml
    participant FX as _entry.xml Changed
    participant FMS as folder-meta-sync.ts
    participant PMS as parent-meta-sync.ts
    participant F as feed.xml

    U->>FA: Create /books/Fiction/SciFi/
    FA->>FS: trigger
    FS->>UE: Create (atomic write)
    UE->>FX: /data watcher detects
    FX->>FMS: trigger
    FMS->>F: Regenerate (atomic write)
    FX->>PMS: trigger
    PMS->>FMS: delegate to parent folder
    FMS->>F: Regenerate parent (atomic write)
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

## Debouncing Strategy

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Accumulating: Event received
    Accumulating --> Accumulating: More events (reset 500ms timer)
    Accumulating --> Flushing: 500ms idle timeout
    Accumulating --> Flushing: 5s max wait timeout
    Flushing --> Idle: All handlers complete
```

- **Idle timeout**: 500ms without new events triggers flush
- **Max wait**: 5 seconds maximum accumulation time
- **Batching**: Multiple events for same path are deduplicated (last event wins)

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

## Loop Prevention

| Event        | Watched? | Reason                                  |
| ------------ | -------- | --------------------------------------- |
| `entry.xml`  | Yes      | Triggers parent feed regeneration       |
| `_entry.xml` | Yes      | Triggers own + parent feed regeneration |
| `feed.xml`   | No       | Would cause infinite loop               |
| `*.tmp`      | No       | Intermediate files                      |
| `cover.jpg`  | No       | No cascade needed                       |
| `thumb.jpg`  | No       | No cascade needed                       |

## Startup Sequence

```mermaid
sequenceDiagram
    participant I as init.sh
    participant IS as initial-sync.ts
    participant S as server.ts
    participant BW as /books watcher
    participant DW as /data watcher

    I->>IS: Run initial sync
    IS->>IS: Scan /books for all books
    IS->>IS: Create sync plan (add/delete/keep)
    IS->>IS: Process new books (via book-sync.ts)
    IS->>IS: Delete orphaned data
    IS->>IS: Generate all feed.xml files

    I->>S: Start HTTP server (background)
    I->>BW: Start /books watcher (background)
    I->>DW: Start /data watcher (background)

    Note over I: Wait for all processes
```
