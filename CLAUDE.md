## Quick Reference

| Instead of              | Use                         |
| ----------------------- | --------------------------- |
| `node`, `ts-node`       | `bun <file>`                |
| `npm install/run`       | `bun install/run`           |
| `jest`, `vitest`        | `bun test`                  |
| `express`               | `Bun.serve()`               |
| `fs.readFile/writeFile` | `Bun.file()`, `Bun.write()` |
| `execa`                 | ``Bun.$`cmd` ``             |
| `crypto`                | `Bun.hash()`                |
| `dotenv`                | ❌ Bun auto-loads .env      |

## Task Completion Checklist

After completing any task:

```bash
bun run lint:fix && bun run format
bun run test
npx knip  # check unused exports/deps
```

Update `PLAN.md`, `CLAUDE.md`, or `@ARCHITECTURE.md` if architecture changed.

## Development Workflow

Docker dev runs at http://localhost:8080 — do NOT run bun locally.
Gracefully shutdown after tests.

```bash
docker compose -f docker-compose.dev.yml up          # start
docker compose -f docker-compose.dev.yml logs -f     # logs
curl http://localhost:8080/feed.xml                  # test
curl -u admin:secret http://localhost:8080/resync    # force resync
```

## Testing

**IMPORTANT:** Run tests via docker-compose.test.yml, not locally!

```bash
# Run all tests (unit + integration, excludes e2e)
docker compose -f docker-compose.test.yml run --rm test

# Run specific test file
docker compose -f docker-compose.test.yml run --rm test bun test test/integration/effect/queue-consumer.test.ts

# Run e2e tests (starts/stops container automatically)
bun run test:e2e

# Type check (locally is fine)
bun --bun tsc --noEmit
```

## Project Structure

```
src/
├── server.ts        # HTTP server + initial sync + DI setup
├── watcher.sh       # inotifywait → POST /events
├── constants.ts     # File constants
├── scanner.ts       # File scanning, sync planning
├── types.ts         # Shared types
├── effect/          # EffectTS event handling
│   ├── types.ts     # RawWatcherEvent schema + EventType
│   ├── services.ts  # DI services
│   ├── consumer.ts  # Event loop
│   ├── adapters/    # event-adapter.ts
│   └── handlers/    # book-sync, folder-sync, etc.
├── formats/         # FormatHandler implementations
│   ├── types.ts     # FormatHandler, BookMetadata
│   ├── index.ts     # Handler registry
│   └── *.ts         # epub, fb2, mobi, pdf, comic, txt, djvu
└── utils/           # archive, image, process, processor
```

## Architecture: Dual Server

```
nginx:80 (external)          Bun:3000 (localhost only)
├── /opds → /feed.xml        ├── POST /events ← watcher
├── /static/* → /app/static  └── POST /resync ← nginx
├── /resync → auth → proxy
└── /* → /data/*
```

## Architecture: EffectTS Layers

1. **Adapters** (`event-adapter.ts`) — raw inotify → typed EventType
2. **Queue** (`EventQueueService`) — typed events only
3. **Consumer** (`consumer.ts`) — gets handler via `HandlerRegistry.get()`
4. **Handlers** (`handlers/*.ts`) — return `EventType[]` for cascades

### DI Services

| Service                | Purpose                               |
| ---------------------- | ------------------------------------- |
| `ConfigService`        | filesPath, dataPath, baseUrl, port    |
| `LoggerService`        | info, warn, error, debug              |
| `FileSystemService`    | mkdir, rm, readdir, stat, atomicWrite |
| `DeduplicationService` | TTL-based (500ms) event filtering     |
| `EventQueueService`    | Queue operations                      |
| `HandlerRegistry`      | Map<tag, handler>                     |
| `ErrorLogService`      | JSONL error logging                   |

### Key Patterns

**Cascade events** — handlers return events, don't call each other:

```typescript
return [{ _tag: "FolderMetaSyncRequested", path: parentDataDir }];
```

**Flag cleanup** — use `Effect.ensuring`:

```typescript
Effect.gen(function* () {
  isSyncing = true;
  yield* doWork;
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      isSyncing = false;
    }),
  ),
);
```

**ManagedRuntime** — share single Layer instance across all Effect calls:

```typescript
// ✅ Correct: single runtime, shared queue
const runtime = ManagedRuntime.make(LiveLayer);
await runtime.runPromise(effect1);
await runtime.runPromise(effect2); // same queue instance

// ❌ Wrong: each provide creates NEW queue instance
await Effect.runPromise(Effect.provide(effect1, LiveLayer));
await Effect.runPromise(Effect.provide(effect2, LiveLayer)); // different queue!
```

**Mirror structure** — /data mirrors /files:

- Book → folder with `entry.xml`, `cover.jpg`, `thumb.jpg`
- Folder → `feed.xml` + `_entry.xml` (for parent)

## Adding New Format Handler

1. Create `src/formats/{format}.ts` with factory pattern
2. Export `registration: FormatHandlerRegistration`
3. Register in `src/formats/index.ts`

## opds-ts Usage

```typescript
import { Entry, Feed } from "opds-ts/v1.2";

const entry = new Entry(id, title)
  .setAuthor(author)
  .addImage(coverUrl)
  .addAcquisition(downloadUrl, mimeType, "open-access");

const feed = new Feed(id, title).setKind("navigation").addSelfLink(href, "navigation");
```
