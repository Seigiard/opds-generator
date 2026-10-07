# In-browser reader

Code: `ui/reader/`, the nginx config, the `ui/vendor/foliate-js` submodule.

## Opening and enabling

- The popup **View** link opens `static/read.html#/<folder>/<file>`. The fragment never reaches nginx.
- Enable a format by adding it to `VIEWABLE_FORMATS` in `src/types.ts`. The renderer needs no edit.

## Security posture

- foliate-js and its pdf.js run attacker-supplied book content. foliate's iframe sandbox gives no isolation (`allow-same-origin` + `allow-scripts`, WebKit bug 218086).
- The CSP is the load-bearing script control. It is an nginx header on `/static/read.html` only, pinned verbatim by `test/e2e/nginx.test.ts`. Keep it at least as strict. `'unsafe-eval'` is forbidden.
- `test/unit/reader/vendor-posture.test.ts` pins the iframe sandbox and `isEvalSupported: false`. A change there needs a security re-review.
- Bump the submodule on upstream security advisories. Follow `ui/vendor/VENDOR.md`.
- The playground serves no CSP. Run the AE3/AE6 security checks against the Docker dev server, per `ui/reader/SMOKE.md`.

## Assets and size

- `static/foliate-<hash>/` is content-hashed and served `immutable`. `read.html` re-declares `no-cache` because nginx `add_header` replaces inherited headers.
- pdf.js loads lazily, only for PDFs. Keep `reader.js` around 4 KB.
- `build:ui` prepends a `getOrInsertComputed` shim (`PDFJS_COMPAT_SHIM`) to the copied pdf.js files so PDFs render on older browsers. Re-check it on every pdf.js bump.
- The Docker image ships committed `static/` only. The container never needs the submodule.
