# OPDS Generator

Static OPDS 1.2 catalog generator from your file structure.

## Philosophy

**Your files, your structure.** This generator respects your existing file organization:

- Files are never modified, renamed, or moved
- No database or proprietary storage format
- Metadata is cached separately in `/data`, mirroring your file structure
- Delete, add, or reorganize files anytime — the catalog updates automatically
- Minimal dependencies, maximum simplicity

## Features

- Automatic directory scanning with file watching
- Metadata extraction from EPUB, FB2, MOBI/AZW, PDF
- Cover extraction from EPUB, FB2, MOBI, CBZ, CBR, CB7, ZIP, PDF
- Auto-detection of ZIP content type (comic or fb2)
- Mirror architecture for easy orphan cleanup
- Extensible format handlers

## Supported Formats

| Format          | Metadata                                     | Cover |
| --------------- | -------------------------------------------- | ----- |
| EPUB            | title, author, description, series           | ✓     |
| FB2/FBZ         | title, author, description, series, genre    | ✓     |
| MOBI/AZW/AZW3   | title, author, publisher, subjects           | ✓     |
| CBZ/CBR/CB7/CBT | title, author, series (ComicInfo.xml, CoMet) | ✓     |
| ZIP             | auto-detect (comic/fb2)                      | ✓     |
| PDF             | title, author, pages (pdfinfo)               | ✓     |
| DJVU            | title, author, keywords, pages (djvused)     | ✓     |
| TXT             | filename                                     | -     |

## Quick Start with Docker

### Docker Compose (recommended)

1. Create `docker-compose.yml`:

```yaml
services:
  opds:
    image: ghcr.io/seigiard/opds-generator:latest
    ports:
      - "8080:80"
    volumes:
      - /path/to/your/books:/books:ro
      - opds-data:/data
    environment:
      # Optional: enable /resync endpoint with Basic Auth
      # - ADMIN_USER=admin
      # - ADMIN_TOKEN=your-secret-token
      # - RATE_LIMIT_MB=5
    restart: unless-stopped

volumes:
  opds-data:
```

2. Run:

```bash
docker compose up -d
```

3. Browse in a web browser at http://localhost:8080/ — or point an OPDS reader at http://localhost:8080/opds

### Docker Run

```bash
docker run -d \
  --name opds \
  -p 8080:80 \
  -v /path/to/your/books:/books:ro \
  -v opds-data:/data \
  ghcr.io/seigiard/opds-generator:latest
```

### Build from Source

```bash
git clone https://github.com/Seigiard/opds-generator.git
cd opds-generator
docker compose up -d --build
```

## Environment Variables

| Variable             | Default  | Description                                       |
| -------------------- | -------- | ------------------------------------------------- |
| `FILES`              | `/books` | Path to your books directory                      |
| `DATA`               | `/data`  | Path for cache and metadata                       |
| `PORT`               | `3000`   | Internal Bun server port                          |
| `DEV_MODE`           | `false`  | Enable hot reload for Bun                         |
| `ADMIN_USER`         | -        | Username for /resync Basic Auth                   |
| `ADMIN_TOKEN`        | -        | Password for /resync Basic Auth                   |
| `RATE_LIMIT_MB`      | `0`      | Download rate limit in MB/s (0 = off)             |
| `RECONCILE_INTERVAL` | `1800`   | Periodic reconciliation seconds (0 = off, min 60) |

## API

| Endpoint               | Audience | Description                                  |
| ---------------------- | -------- | -------------------------------------------- |
| `GET /`                | Browser  | Redirect to /index.html (HTML catalog)       |
| `GET /{path}/`         | Browser  | Subcatalog rendered as HTML (index.html)     |
| `GET /opds`            | Reader   | Root catalog (OPDS feed, 200 XML)            |
| `GET /feed.xml`        | Reader   | Root catalog (OPDS feed)                     |
| `GET /{path}/feed.xml` | Reader   | Subcatalog feed                              |
| `GET /{book}/file`     | Both     | Download book file (symlink)                 |
| `GET /static/*`        | Both     | Static assets (style.css, main.js, favicons) |
| `GET /resync`          | Admin    | Trigger full resync (requires Basic Auth)    |

Browsers get server-rendered HTML (`index.html`, generated at sync time — no browser XSLT); OPDS readers get the `feed.xml` graph via `/opds`. Returns 503 with `Retry-After: 5` while the initial sync is still building a folder.

## Directory Structure

```
/books/                    # Your books (mounted read-only)
├── fiction/
│   └── Foundation.epub
└── comics/
    └── Batman.cbz

/data/                     # Mirror cache (auto-generated)
├── feed.xml               # Root feed (readers)
├── index.html             # Root catalog (browsers, rendered at sync time)
├── fiction/
│   ├── feed.xml           # Subcatalog feed
│   ├── index.html         # Subcatalog HTML
│   ├── _entry.xml         # Entry for parent feed
│   └── Foundation.epub/
│       ├── entry.xml
│       ├── cover.jpg
│       ├── thumb.jpg
│       └── file           # Symlink to /books/fiction/Foundation.epub
└── comics/
    ├── feed.xml
    ├── _entry.xml
    └── Batman.cbz/
        ├── entry.xml
        ├── cover.jpg
        ├── thumb.jpg
        └── file           # Symlink to /books/comics/Batman.cbz
```

## Development

```bash
# Start dev server with hot reload
docker compose -f docker-compose.dev.yml up

# Run tests (in Docker)
bun run test

# Run e2e tests
bun run test:e2e

# Lint + format
bun run fix

# Viewer (browser UI) — sources live in ui/, artifacts in static/
bun run build:ui       # regenerate static/style.css + static/main.js
bun run dev:ui         # Vite preview of renderHtml against cassettes (HMR, no docker)
bun run fixtures:pull  # refresh test/fixtures/feeds/ cassettes from ./data
```

## OPDS Specification

https://specs.opds.io/opds-1.2

## License

MIT
