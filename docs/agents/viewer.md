# Browser viewer

Code: `src/render/feed-html.ts`, `ui/styles`, `ui/gridnav`.

## Model and build

- `FeedModel` is the one source per folder. The `folder-meta-sync` cascade builds it once and writes `feed.xml` (`renderXml`) and then `index.html` (`renderHtml`). HTML is rendered at sync time. There is no browser XSLT.
- Preview with `bun run dev:ui`. Then run `bun run build:ui`, and restart the container or `POST /resync` to regenerate every `index.html`.
- `test/golden/` is byte-exact and `.prettierignore`'d. Every markup change needs `bun run render:golden` and a commit of the goldens.
- `ui/styles/variations.css` cycles through four fixed cover proportions and colors. Each card and its popup share the same variant.
- Book popups use hash + CSS `:target` and work without JS. `main.js` is progressive enhancement only.

## Escaping

- Markup goes through hono's auto-escaping `html` tag (aliased `frag`). It escapes interpolated values for you.
- Join nested `html` fragments with the `interleave` helper. `.join()` drops the escaped marker and double-escapes.
- Escaping does not cover URL schemes. Pass every `href` and `src` through `safeHref`.
- `test/unit/render/escaping.test.ts` pins the contract against `test/fixtures/feeds/hostile.xml`.
