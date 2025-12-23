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
| DJVU, TXT       | filename                                     | -     |

## Quick Start with Docker

### Docker Compose (recommended)

1. Create `docker-compose.yml`:

```yaml
services:
  opds:
    image: ghcr.io/seigiard/opds-generator:latest
    ports:
      - "8080:8080"
    volumes:
      - /path/to/your/books:/books:ro
      - opds-data:/data
    environment:
      - BASE_URL=http://localhost:8080
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
  -p 8080:8080 \
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

| Variable   | Default                 | Description                  |
| ---------- | ----------------------- | ---------------------------- |
| `FILES`    | `/books`                | Path to your books directory |
| `DATA`     | `/data`                 | Path for cache and metadata  |
| `PORT`     | `8080`                  | HTTP port                    |
| `BASE_URL` | `http://localhost:8080` | Base URL for OPDS links      |
| `DEV_MODE` | `false`                 | Disable caching              |

## API

| Endpoint                | Description                            |
| ----------------------- | -------------------------------------- |
| `GET /opds`             | Root catalog                           |
| `GET /opds/{path}`      | Subcatalog or book list                |
| `GET /download/{path}`  | Download file                          |
| `GET /cover/{path}`     | Book cover (1400px max)                |
| `GET /thumbnail/{path}` | Book thumbnail (512px max)             |
| `GET /health`           | Server status (JSON)                   |
| `GET /reset`            | Clear cache and resync (DEV_MODE only) |

## Directory Structure

```
/books/                    # Your books (mounted read-only)
├── fiction/
│   └── Foundation.epub
└── comics/
    └── Batman.cbz

/data/                     # Mirror cache (auto-generated)
├── _feed.xml              # Root feed header
├── fiction/
│   ├── _feed.xml
│   ├── _entry.xml
│   └── Foundation.epub/
│       ├── entry.xml
│       ├── cover.jpg
│       └── thumb.jpg
└── comics/
    ├── _feed.xml
    ├── _entry.xml
    └── Batman.cbz/
        ├── entry.xml
        ├── cover.jpg
        └── thumb.jpg
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
