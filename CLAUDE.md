Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Bun APIs

- `Bun.serve()` for HTTP server. Don't use `express`.
- `Bun.file()` for file operations. Prefer over `node:fs` readFile/writeFile.
- `Bun.$\`cmd\``for shell commands. Don't use`execa`.
- `Bun.hash()` for hashing. Don't use `crypto`.
- `Bun.write()` for writing files.

## Project Structure

```
src/
├── server.ts          # HTTP server + EffectTS Queue + initial sync
├── watcher.sh         # inotifywait → curl POST /events
├── scanner.ts         # File scanning, sync planning
├── processor.ts       # Book/folder processing, XML generation
├── feed-generator.ts  # generateAllFeeds, buildFeed
├── types.ts           # Shared types
├── effect/            # EffectTS-based event handling
│   ├── services.ts    # DI services (Config, Logger, FileSystem)
│   ├── queue.ts       # Queue.unbounded<FileEvent>(), clearQueue
│   ├── events.ts      # FileEvent types + classification + factory functions
│   ├── router.ts      # Event → handler routing
│   └── handlers/      # Effect handlers (book-sync, folder-sync, etc.)
├── formats/           # Format handlers (FormatHandler interface)
│   ├── types.ts       # FormatHandler, BookMetadata
│   ├── index.ts       # Handler registry
│   └── *.ts           # epub, fb2, mobi, pdf, comic, txt, djvu
└── utils/
    ├── archive.ts     # ZIP/RAR/7z/TAR extraction
    └── image.ts       # ImageMagick resize

test/
├── helpers/
│   └── image-compare.ts  # Cover comparison using ImageMagick RMSE
├── unit/                 # Unit tests (including effect/ tests)
└── integration/
    └── formats/          # Format handler integration tests
```

## Architecture: Event-Driven with EffectTS

**Startup**:
1. `server.ts` initializes queue + consumer
2. HTTP server starts (watcher can now connect)
3. `watcher.sh` waits for `/health` (HTTP response), then starts inotifywait
4. `initialSync()` scans files and enqueues BookCreated/FolderCreated events
5. Queue consumer processes events → handlers write entry.xml → watcher catches → cascading feed generation

**Event flow**: inotifywait → curl POST /events → EffectTS Queue → router → Effect handlers

**initialSync flow**: scanFiles → createSyncPlan → enqueue events (same path as watcher)

**Key handlers**:
- `book-sync.ts` — book created/changed → extract metadata, generate entry.xml + covers
- `book-cleanup.ts` — book deleted → rm -rf /data/{path}/
- `folder-sync.ts` — folder created → generate _entry.xml
- `folder-meta-sync.ts` — _entry.xml changed → regenerate feed.xml
- `parent-meta-sync.ts` — entry.xml changed → trigger parent's folder-meta-sync

**Loop prevention**: feed.xml changes are NOT watched (would cause infinite loop).

## Architecture: Mirror Structure

/data mirrors /files structure:

- Each book → folder with entry.xml, cover.jpg, thumb.jpg
- Each folder → \_feed.xml (header) + \_entry.xml (for parent)
- Feed assembly: read \_feed.xml + all nested entry.xml/\_entry.xml

## opds-ts Library

Use opds-ts for OPDS XML generation:

```typescript
import { Entry, Feed } from "opds-ts/v1.2";

// Create book entry
const entry = new Entry(id, title)
  .setAuthor(author)
  .setSummary(description)
  .addImage(coverUrl)
  .addThumbnail(thumbUrl)
  .addAcquisition(downloadUrl, mimeType, "open-access");

const xml = entry.toXml({ prettyPrint: true });

// Create feed
const feed = new Feed(id, title).setKind("navigation").addSelfLink(href, "navigation");
```

## Adding New Format Handler

1. Create `src/formats/{format}.ts`
2. Implement factory pattern:

   ```typescript
   async function createHandler(filePath: string): Promise<FormatHandler | null> {
     const data = await readFileOnce(filePath);
     return {
       getMetadata() {
         return data.metadata;
       },
       async getCover() {
         return data.cover;
       },
     };
   }

   export const registration: FormatHandlerRegistration = {
     extensions: ["ext1", "ext2"],
     create: createHandler,
   };
   ```

3. Register in `src/formats/index.ts`

## Development Workflow

**IMPORTANT**: Docker dev environment is running at http://localhost:8080 and watches for file changes automatically. Do NOT run `bun` locally to test - use curl against the running container.

```bash
# Start dev environment (runs once, then watches for changes)
docker compose -f docker-compose.dev.yml up

# Test changes - just curl the running container
curl http://localhost:8080/health
curl http://localhost:8080/opds

# Check logs
docker compose -f docker-compose.dev.yml logs -f

# Clear data cache (forces full rescan)
docker compose -f docker-compose.dev.yml exec opds sh -c 'rm -rf /data/*'
```

## Testing & Linting

```bash
# Run tests (always in Docker - all tools available)
bun run test

# Run unit tests only
bun run test:unit

# Run integration tests only
bun run test:integration

# Run tests with coverage
bun run test:coverage

# Lint (type-aware, run before commits)
bun run lint

# Lint with auto-fix
bun run lint:fix

# Type check
bun --bun tsc --noEmit
```

**IMPORTANT**: Always run `bun run lint:fix` before committing changes.
**NOTE**: Tests always run in Docker to ensure all tools (pdfinfo, 7zz, imagemagick) are available.

## Documentation

After completing tasks, update PLAN.md and CLAUDE.md if architecture or workflow changed. Keep updates concise — no redundant info.
