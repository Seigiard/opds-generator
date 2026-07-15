## What This Is

OPDS catalog generator for locally stored ebooks. Watches `/books` directory, extracts metadata from epub/fb2/mobi/pdf/djvu/cbz/txt, generates OPDS 1.2 feeds with covers and thumbnails. Browse in any OPDS-compatible reader.

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
| `dotenv`                | Bun auto-loads .env         |
| `curl` in healthcheck   | `wget` (curl not in image)  |

## Task Completion Checklist

After completing any task:

```bash
bun run fix          # format:fix + lint:fix — zero warnings, zero errors policy
bun run test
npx knip             # check unused exports/deps
bun run build:ui     # if you touched ui/ or src/render — regenerates static/style.css + main.js
bun run render:golden # if you touched src/render markup — regenerates + commit test/golden/*.html
```

If you change `ui/styles/*`, `ui/gridnav/*`, or the renderer, run `bun run build:ui` and commit the regenerated `static/` artifacts. `bun run test:all` runs `build:ui:check` (a `git diff --exit-code static/` freshness gate), `render:check`, and `render:pure` before the test suites.

**Renderer gates (host-side, no docker):**

- `bun run render:check` — regenerates `test/golden/*.html` from every cassette and fails on any diff or untracked golden. Byte-exact, no normalization; `test/golden/` is in `.prettierignore` so oxfmt never touches it. Any markup change to `src/render/feed-html.ts` requires re-running `bun run render:golden` and committing the regenerated goldens.
- `bun run render:pure` — proves `src/render/*` stays browser-importable (KTD-7): builds the four modules with `--target=browser` (catches node builtins, direct + transitive) and runs a `Bun`-globals oxlint rule scoped to `src/render/**/*.ts` (see `.oxlintrc.json` `overrides`).

`bun run fix` must produce 0 warnings and 0 errors. Fix all lint/format issues before committing.

**MANDATORY:** Run `bun run test` and verify 0 failures BEFORE every commit. Never commit untested code. If tests fail — fix first, then commit.

**MANDATORY:** Update `CLAUDE.md` when changes affect architecture, dependencies, commands, gotchas, or project structure. CLAUDE.md is the single source of truth for project context.

## Development Workflow

Docker dev runs at http://localhost:8080 — do NOT run bun locally.
Gracefully shutdown after tests.

```bash
git submodule update --init                           # foliate-js reader runtime (first checkout / after clone)
docker compose -f docker-compose.dev.yml up          # start
docker compose -f docker-compose.dev.yml logs -f     # logs
curl http://localhost:8080/feed.xml                  # test
curl -u admin:secret http://localhost:8080/resync    # force resync
```

`ui/vendor/foliate-js` is a pinned git submodule; `build:ui` needs it to regenerate the
reader artifacts (`static/reader.js`, `static/foliate-<hash>/`, `static/read.html`). The
Docker image ships committed `static/` only, so the running container never needs the
submodule — but a fresh clone that runs `build:ui`/`build:ui:check` must init it first.

## Environment Variables

| Variable             | Default  | Description                                                                        |
| -------------------- | -------- | ---------------------------------------------------------------------------------- |
| `FILES`              | `/books` | Source books directory                                                             |
| `DATA`               | `/data`  | Generated metadata cache                                                           |
| `PORT`               | `3000`   | Internal Bun server port                                                           |
| `LOG_LEVEL`          | `info`   | debug \| info \| warn \| error                                                     |
| `DEV_MODE`           | `false`  | Enable Bun --watch hot reload                                                      |
| `ADMIN_USER`         | -        | /resync Basic Auth username                                                        |
| `ADMIN_TOKEN`        | -        | /resync Basic Auth password                                                        |
| `RATE_LIMIT_MB`      | `0`      | Download rate limit MB/s (0 = off); also throttles in-browser reader fetches (R14) |
| `RECONCILE_INTERVAL` | `1800`   | Periodic reconciliation seconds (0 = off, min 60)                                  |

## Testing

**IMPORTANT:** Run tests via docker, not locally!

```bash
# Run unit + integration tests (inside docker)
bun run test

# Run e2e tests (nginx + event logging, outside docker)
bun run test:e2e

# Run ALL tests (unit + integration + e2e)
bun run test:all

# Run specific test file
docker compose -f docker-compose.test.yml run --rm test bun test test/integration/effect/queue-consumer.test.ts

# Type check (locally is fine)
bun --bun tsc --noEmit
```

### Test Structure

```
test/
├── setup.ts             # Global test setup
├── helpers/             # Mock services, assertions, fs utils
├── unit/                # Pure logic, no external deps
│   ├── utils/
│   └── effect/handlers/
├── integration/         # Requires docker (poppler, djvulibre, etc.)
│   ├── formats/         # Format handler tests
│   └── effect/          # Queue + cascade flow tests
└── e2e/                 # Full system tests
    ├── nginx.test.ts    # nginx routing + auth
    └── event-logging.test.ts  # Event lifecycle tracing
```

## Project Structure

```
src/
├── server.ts        # HTTP server + initial sync + DI setup
├── config.ts        # Environment configuration
├── constants.ts     # File constants (feed.xml, entry.xml, etc.)
├── scanner.ts       # File scanning, sync planning
├── types.ts         # Shared types (MIME_TYPES, BOOK_EXTENSIONS)
├── watcher.sh       # inotifywait → POST /events
├── context.ts       # AppContext, HandlerDeps, buildContext()
├── queue.ts         # SimpleQueue<T> (vanilla TS, no Effect)
├── effect/          # Event handling (neverthrow + async/await)
│   ├── types.ts     # RawBooksEvent, RawDataEvent, EventType
│   ├── consumer.ts  # Event loop (AbortController-based)
│   ├── adapters/    # Raw → typed event conversion
│   │   ├── books-adapter.ts    # /books watcher events
│   │   ├── data-adapter.ts     # /data watcher events
│   │   └── sync-plan-adapter.ts # Initial sync → events
│   └── handlers/    # book-sync, folder-sync, etc.
├── render/          # FeedModel + two renderers (no Bun/node:fs — browser-importable)
│   ├── feed-model.ts # FeedModel type + entryFromFragment/buildFeedModel (fast-xml-parser)
│   ├── feed-xml.ts   # renderXml(model) → feed.xml (opds-ts skeleton + spliced fragments)
│   ├── feed-html.ts  # renderHtml(model) → index.html (cards, :target popup, breadcrumb)
│   └── parse-feed.ts # parseFeed(xml) → FeedModel (cassettes + playground)
├── formats/         # FormatHandler implementations
│   ├── types.ts     # FormatHandler, BookMetadata
│   ├── index.ts     # Handler registry
│   ├── utils.ts     # XML parsing utilities
│   └── *.ts         # epub, fb2, mobi, pdf, comic, txt, djvu
├── logging/         # Structured logging
│   ├── types.ts     # LogLevel, LogContext
│   ├── logger.ts    # Flat JSON logger to stdout
│   └── index.ts     # Exports
└── utils/           # archive, image, process, processor, opds

ui/                  # Dev-only viewer sources — NOT copied into the Docker image
├── styles/          # CSS sources (reset, index, header, variations) → static/style.css
├── gridnav/         # main.ts + gridnav.ts → static/main.js (bundled tabbable/focus-trap)
├── reader/          # In-browser reader shell: shell.ts (chrome+foliate boundary),
│                    #   fragment.ts (R15 URL validation), reader.ts (prod entry),
│                    #   read.html (template), reader.css → static/reader.js + read.html;
│                    #   SMOKE.md (U6 manual checklist)
├── vendor/          # foliate-js pinned git submodule + VENDOR.md (provenance/audit)
├── playground/      # Vite pages: index.html (cassette → renderHtml preview) and
│                    #   reader.html (fixtures → shell smoke); fixtures/ (smoke EPUBs)
└── scripts/         # build-ui.ts (build:ui), fixtures-pull.ts (fixtures:pull),
                     #   render-golden.ts (render:golden/check), render-purity.ts (render:pure),
                     #   build-smoke-fixtures.ts (regenerates ui/playground/fixtures/*.epub)

static/              # Committed build artifacts served by nginx
├── style.css        # Generated by build:ui (PostCSS pipeline; do not edit by hand)
├── main.js          # Generated by build:ui (Bun.build; excluded from oxlint/oxfmt)
├── reader.js        # Generated by build:ui (reader shell bundle; no-cache like main.js)
├── read.html        # Generated by build:ui (reader page; refs the hashed foliate dir)
├── foliate-<hash>/  # Generated by build:ui: vendored foliate+pdf.js runtime,
│                    #   content-hashed → immutable-cacheable; pdf.js loads lazily
└── favicon/         # Static favicons

test/golden/         # Byte-exact renderHtml output per cassette; generated by render:golden,
                     #   gated by render:check, .prettierignore'd — never hand-edit
```

### Viewer: single model, two renderers

`FeedModel` is the one source of truth per folder. The `folder-meta-sync` cascade builds it once and writes two artifacts from it: `feed.xml` via `renderXml` (readers) and `index.html` via `renderHtml` (browsers). No browser XSLT — HTML is rendered at sync time. `parseFeed` reconstructs a model from a feed.xml for cassettes and the playground.

**To change the browser template:** edit `src/render/feed-html.ts` (markup) and/or `ui/styles/*` (CSS). Run `bun run dev:ui` for a live HMR preview against real cassettes. Run `bun run build:ui` to regenerate `static/style.css` + `static/main.js`, then restart the container (or `POST /resync`) to regenerate every `index.html`. **After any markup change, run `bun run render:golden` and commit the regenerated `test/golden/*.html`** — `render:check` fails otherwise. Never hand-edit `static/style.css`, `static/main.js`, or `test/golden/*`.

`feed-html.ts` renders through hono/html's auto-escaping ` html` ``tag (aliased `frag` for the sync/non-Promise narrowing) — interpolated data values are escaped by default (`&<>"'`), so there are no manual `escapeHtml`/`escapeAttr` calls. Rules: never `.join()` nested`` html` ` fragments (strips the escaped marker → double-escape); interleave fragment arrays with literal separators via the `interleave` helper. Auto-escaping does not cover URL schemes — every href/src goes through `safeHref`, which drops anything but `http(s)`/relative/`#` to `#`. The escaping contract is pinned by `test/unit/render/escaping.test.ts` against the hand-authored `test/fixtures/feeds/hostile.xml` cassette.

Book detail popups use hash + CSS `:target` (works with no JS). `main.js` is progressive enhancement (gridnav keyboard nav, focus trap, Esc/Back close) and is not on the critical path.

## Architecture: Dual Server

```
nginx:80 (external)                      Bun:3000 (localhost only)
├── / → 302 /index.html (browsers)       ├── POST /events/books ← books watcher
├── /<folder>/ → index.html (browsers)   ├── POST /events/data ← data watcher
├── /opds → 302 /feed.xml (readers)      └── POST /resync ← nginx
├── /<folder>/feed.xml → feed (readers)
├── /static/* → /app/static
├── /resync → auth → proxy
└── downloads/covers → /data/*
```

Audience split is by URL structure, not content negotiation: readers follow the explicit `feed.xml` link graph, browsers follow folder URLs to `index.html`. During initial sync / mid-cascade, folder URLs and missing `index.html`/`feed.xml` return 503 (`@check_initializing`).

## Architecture: Event Processing

1. **Adapters** (`adapters/*.ts`) — raw inotify → typed EventType
2. **Queue** (`SimpleQueue<EventType>`) — unrolled queue + Promise waiters; pending `FolderMetaSyncRequested` events are coalesced by path and moved behind later queued work
3. **Consumer** (`consumer.ts`) — `while (!signal.aborted)` loop with `queue.take(signal)`
4. **Handlers** (`handlers/*.ts`) — return `Result<EventType[], Error>` for cascades

### DI via AppContext + Pick<>

| Field in AppContext | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `config`            | filesPath, dataPath, port, reconcileInterval          |
| `logger`            | info, warn, error, debug (void, fire-and-forget)      |
| `fs`                | mkdir, rm, readdir, stat, atomicWrite (Promise-based) |
| `dedup`             | TTL-based (500ms) event filtering (synchronous)       |
| `queue`             | SimpleQueue: enqueue, enqueueMany, take, size         |
| `handlers`          | Map<tag, AsyncHandler>                                |

Handlers receive `HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">`.

### Key Patterns

**Cascade events** — handlers return events via neverthrow:

```typescript
return ok([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }]);
```

**Flag cleanup** — use `try/finally`:

```typescript
isSyncing = true;
try {
  await doWork();
} finally {
  isSyncing = false;
}
```

**Graceful shutdown** — AbortController:

```typescript
const controller = new AbortController();
const consumerTask = startConsumer(ctx, controller.signal);
// ...
controller.abort();
await Promise.allSettled([consumerTask, reconcileTask]);
```

**Mirror structure** — /data mirrors /books:

- Book → folder with `entry.xml`, `cover.jpg`, `thumb.jpg`, `file` (symlink)
- Folder → `feed.xml` + `_entry.xml` (for parent)

## Adding New Format Handler

1. Create `src/formats/{format}.ts` implementing FormatHandler interface
2. Export `registration: FormatHandlerRegistration`
3. Import and add to registrations array in `src/formats/index.ts`

### Handler Interface

```typescript
interface FormatHandler {
  getMetadata(): BookMetadata;       // Sync extraction
  getCover(): Promise<Buffer | null>; // Async cover extraction
}

interface FormatHandlerRegistration {
  extensions: string[];               // ["epub", "epub3"]
  create: FormatHandlerFactory;       // async factory function
}
```

### Supported Formats

| Format | Extensions         | Dependencies      |
| ------ | ------------------ | ----------------- |
| EPUB   | .epub              | unzip             |
| FB2    | .fb2, .fbz         | unzip (fbz)       |
| MOBI   | .mobi, .azw, .azw3 | -                 |
| PDF    | .pdf               | poppler-utils     |
| DJVU   | .djvu              | djvulibre         |
| Comics | .cbz, .cbr, .cb7   | node-7z, unrar-js |
| Text   | .txt               | -                 |

## opds-ts Usage

```typescript
import { Entry, Feed } from "opds-ts/v1.2";

const entry = new Entry(id, title)
  .setAuthor(author)
  .addImage(coverUrl)
  .addAcquisition(downloadUrl, mimeType, "open-access");

const feed = new Feed(id, title).setKind("navigation").addSelfLink(href, "navigation");
```

## Troubleshooting

### Dependency Notes

- `sharp` includes its own TypeScript definitions; do not add `@types/sharp`.
- `detect-libc` is pulled transitively by `sharp`; do not add it as a direct dependency unless app code imports it.
- `hono` is a runtime `dependency` (the renderer runs in the production image): `src/render/feed-html.ts` imports `html` from `hono/html` for auto-escaping. Zero transitive deps, browser-importable (proven by `render:pure`). After changing render deps, rebuild the test image: `bun run rebuild:test`.
- `ui/vendor/foliate-js` (submodule) and its bundled pdf.js are **security-sensitive**: they execute attacker-supplied book content. Bump the submodule on upstream security advisories, not just for features — see `ui/vendor/VENDOR.md` for the pinned commit, pdf.js version/checksums (≥ CVE-2024-4367 fix), and the update procedure. `test/unit/reader/vendor-posture.test.ts` pins foliate's iframe sandbox + pdf.js `isEvalSupported: false`; a bump that changes either forces a security re-review.

### Infinite Loop in Watchers

- data watcher excludes `.jsonl` files and `index.html`
- feed.xml and index.html are NOT watched (data-adapter classifies only entry.xml/\_entry.xml; everything else → Ignored)
- `index.html` is written by the cascade after `feed.xml` (same model); an HTML render failure is logged and does not block the feed
- Check watcher.sh exclusion patterns

### Viewer / index.html

- Browser HTML is rendered at sync time (`src/render/feed-html.ts`), not by XSLT in the browser — `layout.xsl` and the `<?xml-stylesheet?>` PI were removed (Chrome 158 drops XSLT 2026-11-17)
- `static/style.css` and `static/main.js` are generated by `bun run build:ui`; never hand-edit them
- Editing CSS reshuffles all `random()` card hues (seed = source length) — expected, not a bug
- Preview renderer changes live with `bun run dev:ui` (Vite, no docker); refresh cassettes with `bun run fixtures:pull`

### In-browser reader (ui/reader/)

- The popup **View** link (epub/pdf) opens `static/read.html#/<folder>/<file>`; the fragment never hits nginx (KTD-1). Viewability is the `VIEWABLE_FORMATS` set in `src/types.ts` (next to `MIME_TYPES`) — enabling a format is a one-line registry change, no renderer edit. `renderDownloads()` consults it; both `feed-html.ts` and `reader.ts` are browser bundles, so `src/types.ts` must stay free of Bun/node imports.
- The reader CSP is the **load-bearing script control**, not foliate's iframe sandbox (which combines `allow-same-origin`+`allow-scripts` and provides no isolation — WebKit bug 218086). It ships as an nginx response header on `/static/read.html` only (KTD-6), pinned verbatim by `test/e2e/nginx.test.ts`. Never widen it; never add `'unsafe-eval'`.
- `static/foliate-<hash>/` is content-hashed and regenerates in lockstep with `read.html` in one `build:ui` run, so nginx serves it `immutable` (unlike the no-cache unversioned assets). `read.html` re-declares `no-cache` because nginx `add_header` **replaces** inherited headers.
- pdf.js loads lazily — only when a PDF opens (R13); EPUB readers fetch none of it. `reader.js` stays ~4 KB.
- pdf.js 5.5.207 needs `Map.prototype.getOrInsertComputed` (Chrome/Edge 145+, FF 144+, Safari 18.4+); `build:ui` prepends a spec-shaped shim to the copied `pdf.mjs` + `pdf.worker.mjs` (`PDFJS_COMPAT_SHIM`, folded into the dir hash; submodule stays pristine) so PDFs render below that floor. Re-check on a pdf.js bump. See `ui/vendor/VENDOR.md`.
- Never hand-edit `static/reader.js`, `static/read.html`, or `static/foliate-*/`. After changing `ui/reader/*`, run `bun run build:ui` and commit the regenerated `static/`.
- Reader rendering: `bun run dev:ui` → http://localhost:5173/reader.html (fixtures in `ui/playground/fixtures/`). **The playground serves no CSP** — the AE3/AE6 security checks must run against the docker dev server. Full checklist: `ui/reader/SMOKE.md`.

### Tests Failing

- Always run tests in Docker: `bun run test`
- Rebuild Docker image after dependency changes: `bun run rebuild:test`
- Integration tests require poppler-utils, djvulibre (in Docker image)
- Check test fixtures exist in test/fixtures/

### Resync Not Working

- Requires ADMIN_USER + ADMIN_TOKEN environment variables
- nginx removes auth block if not configured
- Check entrypoint.sh AUTH_ENABLED logic

### Healthcheck Commands

Docker healthcheck uses `wget` (NOT `curl` — not in alpine image):

```bash
wget -q --spider http://127.0.0.1/feed.xml
```
