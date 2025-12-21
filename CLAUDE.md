Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Bun APIs

- `Bun.serve()` for HTTP server. Don't use `express`.
- `Bun.file()` for file operations. Prefer over `node:fs` readFile/writeFile.
- `Bun.$\`cmd\`` for shell commands. Don't use `execa`.
- `Bun.hash()` for hashing. Don't use `crypto`.
- `Bun.write()` for writing files.

## Project Structure

```
src/
├── index.ts           # HTTP server + fs.watch
├── scanner.ts         # File scanning, sync planning
├── processor.ts       # Book/folder processing, XML generation
├── opds.ts            # Feed assembly from XML files
├── types.ts           # Shared types
├── formats/           # Format handlers (FormatHandler interface)
│   ├── types.ts       # FormatHandler, BookMetadata
│   ├── index.ts       # Handler registry
│   ├── epub.ts        # EPUB handler
│   └── cbz.ts         # CBZ/CBR handler
└── utils/
    ├── zip.ts         # ZIP extraction (unzip wrapper)
    └── image.ts       # ImageMagick resize
```

## Architecture: Mirror Structure

/data mirrors /files structure:
- Each book → folder with entry.xml, cover.jpg, thumb.jpg
- Each folder → _feed.xml (header) + _entry.xml (for parent)
- Feed assembly: read _feed.xml + all nested entry.xml/_entry.xml

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
const feed = new Feed(id, title)
  .setKind("navigation")
  .addSelfLink(href, "navigation");
```

## Adding New Format Handler

1. Create `src/formats/{format}.ts`
2. Implement `FormatHandler` interface:
   ```typescript
   export const handler: FormatHandler = {
     extensions: ["ext1", "ext2"],
     async getMetadata(filePath) { ... },
     async getCover(filePath) { ... }
   };
   ```
3. Register in `src/formats/index.ts`

## Docker Development

```bash
# Dev with hot-reload
docker compose -f docker-compose.dev.yml up

# Check logs
docker compose -f docker-compose.dev.yml logs -f

# Clear data cache
docker compose -f docker-compose.dev.yml exec opds sh -c 'rm -rf /data/*'
```

## Testing

```bash
bun test
```
