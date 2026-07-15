# Vendored reader dependencies

Both are security-sensitive: they execute attacker-supplied book content in the
browser. Bump the submodule on upstream security advisories, not just for features.

## foliate-js

- Source: https://github.com/johnfactotum/foliate-js (MIT, no releases — pinned git submodule per upstream guidance)
- Pinned commit: `78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01)
- Update: `git -C ui/vendor/foliate-js fetch && git -C ui/vendor/foliate-js checkout <commit>`, review the diff, run `bun run build:ui`, re-run the smoke checklist (`ui/reader/SMOKE.md`), commit the new gitlink + regenerated `static/`.

## pdf.js (via foliate-js)

- Shipped inside the submodule at `vendor/pdfjs/` (built from the `pdfjs-dist` npm package by upstream).
- Version: **5.5.207** — at or above the CVE-2024-4367 fix (4.2.67); the foliate adapter sets `isEvalSupported: false`.
- Checksums (sha256):
  - `pdf.mjs` `70f8fd59e1c947d32ebfc7e5b101cc164d305fe98c44523355355ab79875d9e9`
  - `pdf.worker.mjs` `682770dbc7ac4d94017b79628aa8c231934415f80a76ed99be09ed743912a0ab`
- `build:ui` copies the foliate runtime (pdf.js included, under `vendor/pdfjs/`) into `static/foliate-<hash>/` (content-hashed → immutable-cacheable); the hash is cache-busting, this note is the provenance/audit trail (KTD-3).
- **Compat shim:** pdf.js 5.5.207 calls `Map.prototype.getOrInsertComputed` (main thread + worker, in the page-render path, not just metadata) — a builtin that only shipped in Chrome/Edge 145, Firefox 144, Safari 18.4. Below that floor the PDF path throws `getOrInsertComputed is not a function`. `build:ui` prepends a spec-shaped shim (`PDFJS_COMPAT_SHIM` in `ui/scripts/build-ui.ts`) to the copied `pdf.mjs` **and** `pdf.worker.mjs` (the worker's global scope doesn't inherit a main-thread prototype patch). The **submodule stays pristine** — the patch lives only in the committed `static/` copy, is folded into the dir hash, and no-ops where the builtin exists natively. On a pdf.js bump, re-check whether the shim is still needed.
- foliate's book iframes ship `sandbox="allow-same-origin allow-scripts"` (upstream needs both: WebKit bug 218086 for event delivery, `contentDocument` access for rendering) — so the sandbox provides no script isolation and the reader CSP (`nginx.conf.template`, KTD-6) is the load-bearing control. `test/unit/reader/vendor-posture.test.ts` pins the exact attribute so a submodule bump that changes it forces a security re-review.
