# Reader Shell Smoke Checklist (U6, KTD-5)

The reader has no browser-automation test suite (KTD-5). This checklist is the v1
verification tier for in-browser rendering quality and the CSP security contract.
Run it and record the results in the PR description before shipping.

Two tiers, two environments — **do not conflate them**:

| Tier               | Environment                                          | Proves                                                    | CSP present?           |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| Rendering          | `bun run dev:ui` → http://localhost:5173/reader.html | pagination, TOC, position, chrome, PDF fidelity           | **No**                 |
| Security (AE3/AE6) | docker dev server → `/static/read.html#/<book>`      | scripted content blocked, negative-content matrix blocked | **Yes (nginx header)** |

The Vite playground serves **no CSP header**, so it can only exercise foliate's iframe
sandbox — which is _not_ the control. Confirmed during U6: the `scripted.epub` inline
script executes inside the blob: iframe under `dev:ui`. Only the production nginx CSP
(`script-src 'self'`, inherited into the blob: iframe) stops it. **AE3/AE6 must be run
against the docker dev server, never the playground.**

## Fixtures

Committed under `ui/playground/fixtures/` (hand-authored, license-clean; regenerate with
`bun ui/scripts/build-smoke-fixtures.ts`):

- `baseline.epub` — two chapters + nav TOC, long enough to paginate.
- `scripted.epub` — inline `<script>`, `<img onerror>`; the AE3 script-execution probe.
- `csp-matrix.epub` — every AE6 passive vector in one chapter.

User-supplied local files (not committed — license/size; plan fixture assumption):

- A **representative complex PDF** from the real catalog (multi-column, embedded fonts, images).
- A **malicious-font PDF** (CVE-2024-4367-style) to confirm nothing executes.
- `epub-test` (github.com/johnfactotum/epub-test) as an additional scripted-EPUB cross-check.

## Rendering tier — `bun run dev:ui`

Open `http://localhost:5173/reader.html?fixture=baseline.epub`.

- [ ] EPUB renders; the page is readable.
- [ ] `ArrowRight` / `ArrowLeft` and the on-screen nav buttons page forward/back.
- [ ] The position indicator advances (e.g. `17% · 1 / 10` → `33% · 2 / 10`).
- [ ] "Contents" opens the TOC; a TOC entry navigates and closes the panel.
- [ ] `Esc` and "Catalog" both return to the folder link.
- [ ] Focus lands on the book view on load, not the address bar.
- [ ] Mobile viewport (DevTools device toolbar): the shell is usable; note tap/zoom affordances as known limitations.

**Automated Chromium check performed in U6** (via Playwright against `dev:ui`): baseline
renders with title from metadata, TOC visible, position `17% · 1 / 10`, `ArrowRight`
advances to `2 / 10`. Recorded here so the manual rendering pass can focus on judgement
calls (fidelity, mobile) rather than re-proving the wiring.

### PDF (the foliate-adapter bet — Goal Capsule stop condition)

> **Compat note:** pdf.js 5.5.207 needs `Map.prototype.getOrInsertComputed` (Chrome/Edge
> 145+, Firefox 144+, Safari 18.4+). `build:ui` prepends a shim to `pdf.mjs` + `pdf.worker.mjs`
> so PDFs render below that floor too (verified on Chrome 143: renders + paginates, 0 console
> errors). If a pdf.js bump introduces another too-new builtin, this smoke will surface it.

Open the representative complex PDF in the shell. Record **pass/fail against these
thresholds**, not subjective notes:

- [ ] **Rendering correctness:** every page renders; no missing text, images, or blank pages on a spot-check of ≥10 pages including the most complex spread.
- [ ] **Page navigation:** forward/back and jump-to-TOC land on the correct page.
- [ ] **First-page latency:** first page paints within an acceptable budget on the target device — **record the measured seconds**; a multi-second stall is a finding, not a pass.
- [ ] **Failure states visible:** a deliberately truncated/corrupt PDF shows "Couldn't load this book." + Return, never a blank page or a hang.

**If the complex PDF fails any threshold → STOP.** Surface the pdf.js-display-layer
fallback decision (Goal Capsule) — do not ship PDF half-working.

## Security tier — docker dev server (CSP active)

Place `scripted.epub` and `csp-matrix.epub` into the `/books` dir the docker dev server
watches, let them sync, then open each via its catalog **View** link (or
`/static/read.html#/<folder>/<book>`). Run the whole tier in **both a Chromium engine and
a WebKit engine** — the sandbox-escape foliate warns about is WebKit-specific (bug 218086).

AE3 — scripted EPUB (`scripted.epub`, and `epub-test`):

- [ ] The probe paragraph text is unchanged (no "SCRIPT EXECUTED").
- [ ] The document title is not rewritten by the `onerror` handler.
- [ ] DevTools shows a CSP violation report as the only observable effect; no script ran, including inside the blob: iframe.
- [ ] Repeated in the WebKit engine with the same result.

AE6 — negative-content matrix (`csp-matrix.epub`): with the Network tab open, confirm
**no external request and no same-origin non-book request** for every vector:

- [ ] `<object>` / `<embed>` (external) — blocked (`object-src 'none'`).
- [ ] external `<img src>` — blocked (`img-src` has no external host).
- [ ] same-origin `<img src="/resync">` and `<img srcset="/resync">` — **no request to `/resync`** (a credentialed resync must never fire).
- [ ] external `<script src>` — blocked (`script-src 'self'`).
- [ ] `<form action="/resync">` — submission blocked (`form-action 'none'`).
- [ ] `<base href>` rewrite — inert (`base-uri 'none'`).
- [ ] CSS `@import url("/resync")` and external `@import` — no request.
- [ ] `@font-face` external `src` — no request (`font-src` falls back to `default-src 'none'`).
- [ ] CSS `url()` exfil (`content:`/background) external — no request.
- [ ] Repeated in the WebKit engine.

Malicious-font PDF:

- [ ] Opens (or fails cleanly); nothing executes; no CSP-eval violation (pdf.js runs with `isEvalSupported: false`).

## Recorded results — 2026-07-15 (automated, docker dev server, CSP active)

Driven by Playwright against `http://localhost:8080/static/read.html` (real nginx CSP),
both engines. Fixtures: `scripted.epub`, `csp-matrix.epub`, and a real **73-page** technical
PDF ("Next.js Performance Optimization", embedded fonts/images/code) as the complex-PDF case.

| Check | Chromium (149) | WebKit (Playwright 2251) |
| --- | --- | --- |
| **AE3** scripted EPUB: `window.__scriptRan` | `false` (script blocked) | `false` (script blocked) |
| **AE3** `onerror` rewrote title | no | no |
| **AE3** CSP violations fired | 2 | 2 |
| **AE6** hostile requests attempted | 5 | 0 |
| **AE6** hostile requests that **succeeded** | **0** (all `net::ERR_BLOCKED_BY_CSP`) | **0** |
| **PDF** opens + reads metadata | yes | yes |
| **PDF** first paint | 267 ms | 275 ms |
| **PDF** paginates (73-page doc) | 1/73 → 3/73 | 1/73 → 3/73 |

Notes:
- WebKit reports the inline-`<script>` block with different console wording than Chromium, so a
  message-text match misses it — but `__scriptRan === false` and the untouched title are the
  functional proof the script never executed. AE3 holds in both engines.
- AE6: Playwright fires a `request` event for CSP-blocked loads in Chromium (then `requestfailed`
  with `net::ERR_BLOCKED_BY_CSP`); WebKit blocks before the event. In **both**, zero hostile
  requests (`evil.example` or `/resync`) completed.
- The **malicious-font PDF (CVE-2024-4367)** vector is closed structurally, not by crafting an
  exploit: pdf.js runs with `isEvalSupported: false` (pinned by `vendor-posture.test.ts`) and the
  vendored pdf.js 5.5.207 is well past the 4.2.67 fix. Re-check on a pdf.js downgrade.
- Still worth a human eye before ship: PDF **rendering fidelity** on a PDF representative of *your*
  catalog (the 73-page technical PDF passed, but only you know your worst case), and mobile
  tap/zoom affordances.

## Recording

Paste the completed checklist (with the PDF latency number and each engine's result) into
the PR description. A tier left unrun is a tier that failed — say so explicitly.
