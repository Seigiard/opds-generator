# Browser viewer

Code: `src/render/feed-html.ts`, `ui/styles`, `ui/gridnav`.

Generated feed and entry links use `/_catalog/`. The static shell at `static/index.html` is served on `/` and every folder path. It fetches `/_catalog/<path>/feed.xml`, parses the feed in the browser and renders the `renderHtml` fragment. Folder cards keep the browser URL (`/<folder>/`). Breadcrumbs come from URL path segments, while the folder heading and browser tab title come from the feed title.

## Model and build

- `FeedModel` is the one source per folder. The `folder-meta-sync` cascade builds it once and writes `feed.xml` (`renderXml`) and `_entry.xml` for non-root folders. The shell fetches and parses the feed, then renders the `renderHtml(model, crumbs)` fragment in the browser. There is no browser XSLT.
- Preview with `bun run dev:ui`. Then run `bun run build:ui`. Markup and CSS changes do not need a processing-version bump. Bump `PROCESSING_VERSIONS.folder` when feed or entry links, or `_entry.xml`, change; a restart or ordinary pass then rebuilds stale folders. `POST /resync?force=1` also reprocesses everything.
- `test/golden/` is byte-exact and `.prettierignore`'d. Every markup change needs `bun run render:golden` and a commit of the goldens.
- `ui/styles/variations.css` cycles through four fixed cover proportions and colors. Each card and its popup share the same variant.
- JavaScript is required: `main.js` boots the shell, renders the catalogue and opens dialogs with `showModal()`.
  Without JavaScript, only the `<noscript>` link to `/opds` is available.
- The shell waits 300 ms before showing loading feedback. A slower feed gets a
  header and card skeleton built from the regular header, grid, card, and cover
  variants; a fast feed renders directly without a loading flash. Starting,
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
