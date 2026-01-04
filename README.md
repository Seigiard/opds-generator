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
      - BASE_URL=http://localhost:8080
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
docker-compose up -d
```

3. Open http://localhost:8080/opds

### Docker Run

```bash
docker run -d \
  --name opds \
  -p 8080:80 \
  -v /path/to/your/books:/books:ro \
  -v opds-data:/data \
  -e BASE_URL=http://your-server:8080 \
  ghcr.io/seigiard/opds-generator:latest
```

### Build from Source

```bash
git clone https://github.com/Seigiard/opds-generator.git
cd opds-generator
docker-compose up -d --build
```

## Environment Variables

| Variable        | Default                 | Description                           |
| --------------- | ----------------------- | ------------------------------------- |
| `FILES`         | `/books`                | Path to your books directory          |
| `DATA`          | `/data`                 | Path for cache and metadata           |
| `PORT`          | `3000`                  | Internal Bun server port              |
| `BASE_URL`      | `http://localhost:8080` | Base URL for OPDS links               |
| `DEV_MODE`      | `false`                 | Enable hot reload for Bun             |
| `ADMIN_USER`    | -                       | Username for /resync Basic Auth       |
| `ADMIN_TOKEN`   | -                       | Password for /resync Basic Auth       |
| `RATE_LIMIT_MB` | `0`                     | Download rate limit in MB/s (0 = off) |

## API

| Endpoint           | Description                                     |
| ------------------ | ----------------------------------------------- |
| `GET /`            | Redirect to /feed.xml                           |
| `GET /opds`        | Redirect to /feed.xml                           |
| `GET /feed.xml`    | Root catalog (OPDS feed)                        |
| `GET /{path}/`     | Subcatalog (serves feed.xml as directory index) |
| `GET /{book}/file` | Download book file (symlink)                    |
| `GET /static/*`    | Static files                                    |
| `GET /resync`      | Trigger full resync (requires Basic Auth)       |

Note: nginx serves static files from `/data`. Returns 503 with `Retry-After: 5` if feed.xml doesn't exist yet (initial sync in progress).

## Directory Structure

```
/books/                    # Your books (mounted read-only)
├── fiction/
│   └── Foundation.epub
└── comics/
    └── Batman.cbz

/data/                     # Mirror cache (auto-generated)
├── feed.xml               # Root feed
├── fiction/
│   ├── feed.xml           # Subcatalog feed
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
# Install dependencies
bun install

# Run dev server with hot reload
bun run dev

# Run tests (in Docker)
bun run test

# Lint
bun run lint:fix

# Production
FILES=/books DATA=/data bun run start
```

## OPDS Specification

https://specs.opds.io/opds-1.2

## License

MIT
