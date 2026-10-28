# Browser viewer

Code: `src/render/feed-html.ts`, `src/render/frag.ts`, `src/render/shell-state.ts`, `ui/styles`, `ui/gridnav`, `ui/gridnav/folder-load.ts`, `ui/gridnav/popup-rules.ts`.

Generated feed and entry links use `/_catalog/`. The static shell at `static/index.html` is served on `/` and every folder path. It fetches `/_catalog/<path>/feed.xml`, parses the feed in the browser and renders the `renderHtml` fragment. Folder cards keep the browser URL (`/<folder>/`). Breadcrumbs come from URL path segments, while the folder heading and browser tab title come from the feed title.

## Model and build

- `FeedModel` is the one source per folder. The `folder-meta-sync` cascade builds it once and writes `feed.xml` (`renderXml`) and `_entry.xml` for non-root folders. The shell fetches and parses the feed, then renders the `renderHtml(model, crumbs)` fragment in the browser. There is no browser XSLT.
- Preview with `bun run dev:ui`. Then run `bun run build:ui`. Markup and CSS changes do not need a processing-version bump. Bump `PROCESSING_VERSIONS.folder` when feed or entry links, or `_entry.xml`, change; a restart or ordinary pass then rebuilds stale folders. `POST /resync?force=1` also reprocesses everything.
- `test/golden/` is byte-exact and `.prettierignore`'d. Every markup change needs `bun run render:golden` and a commit of the goldens.
- Each card wrapper carries `data-ratio`, a width/height ratio in 0.600–0.734 from the title hash (`coverRatioFromTitle` in `src/render/lqip.ts`). The shell copies it into `--cover-ratio`, so a book keeps its shape when the folder order changes; the card, its popup and a folder shelf inherit it. Skeleton cards have no title, so they all use the default `225/350` from `.book`.
- Every `.book__cover` (book card, popup, folder shelf) carries `data-lqip`, a 20-bit code from the title (`src/render/lqip.ts`). The shell copies it into `--lqip` with `style.setProperty` (`applyCoverStyles`), because the shell CSP `style-src 'self'` blocks style attributes. `ui/styles/lqip.css` decodes it into a gradient placeholder behind the cover image, so it shows when there is no cover, while it loads, and after a load error (`ui/gridnav/cover-placeholder.ts` removes the broken `<img>`). Browsers without CSS `mod()`/`round()` get a flat colour.
- JavaScript is required: `main.js` boots the shell, renders the catalogue and opens dialogs with `showModal()`.
  Without JavaScript, only the `<noscript>` link to `/opds` is available.
- The shell waits 300 ms before showing loading feedback. A slower feed gets a
  header and card skeleton built from the regular header, grid, card, and cover
  markup; a fast feed renders directly without a loading flash. Starting,
  not-found, and error states remain status-specific.
- After rendering a folder, the shell low-priority prefetches up to 20 folder
  `feed.xml` links. It skips prefetching only when
  `navigator.connection?.saveData === true`, and never prefetches covers or book
  files. Nginx sends `Cache-Control: max-age=30`; the browser may reuse a feed
  for 30 s, so a subsequent folder navigation can reuse it.

## Escaping

- Markup goes through hono's auto-escaping `html` tag (aliased `frag`). It escapes interpolated values for you.
- Join nested `html` fragments with the `interleave` helper. `.join()` drops the escaped marker and double-escapes.
- Escaping does not cover URL schemes. Pass every `href` and `src` through `safeHref`.
- `test/unit/render/escaping.test.ts` pins the contract against `test/fixtures/feeds/hostile.xml`.
