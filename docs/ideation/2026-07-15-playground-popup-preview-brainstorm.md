---
title: Playground popup preview — brainstorm
type: ideation
date: 2026-07-15
topic: playground-popup-preview
status: parked
related:
  - docs/plans/2026-07-14-002-refactor-native-dialog-popup-plan.md
---

# Playground popup preview — brainstorm

Parked follow-up from the native-`<dialog>` popup refactor (PR #4). The plan
explicitly deferred this ("Deferred to Follow-Up Work"). Written to return to
later, not to execute now.

## The question

Can `bun run dev:ui` (the Vite playground) open book popups, so local renderer
work does not require docker to verify popup behavior?

## What is actually broken (clearing a misconception)

The `<dialog>` markup is **not** the problem. `renderBook()` in
`src/render/feed-html.ts` already emits a full `<dialog class="popup" id="book-N">`
per book — in both production and the playground. hono generates them eagerly.

The gap is JavaScript:

- A `<dialog>` is inert HTML until JS calls `.showModal()`. There is **no**
  HTML/CSS-only way to open a _modal_ dialog (backdrop + focus containment + top
  layer). The `open` attribute alone yields a _non-modal_ dialog — the degraded
  mode we deliberately retired when we dropped `:target`.
- Production serves a static `index.html` (dialogs baked in at sync time) and
  `static/main.js` calls `showModal()` on `hashchange`. Markup is rendered once.
- The playground (`ui/playground/main.ts:27`) injects `renderHtml()` output into
  `#preview` via `innerHTML` **on each cassette switch** — because each cassette
  is a different feed. It never runs `ui/gridnav/main.ts`, so `showModal()` is
  never called and clicking a card only sets `#book-N`.

So enabling popups = run the `main.ts` driver against the preview, and re-wire it
after every cassette switch (the swap destroys the previous dialogs + Gridnav).

## Why re-wiring is the tricky part

`main.ts.init()` is not idempotent. Its `keydown`/`click`/`hashchange` listeners
live on `document`/`window` and survive an `innerHTML` swap; its `cancel`/`close`
listeners live on the `<dialog>` elements and are destroyed by the swap. A naive
re-call of `init()` on each render would duplicate the document/window listeners
(leak) while correctly re-binding the per-dialog ones.

## Options

### A. Split `main.ts` into `initGlobal()` + `wire(root)` (recommended)

- `initGlobal()` — attach document/window listeners once (Esc-first-nav guard,
  `hashchange` → `syncPopup`, close-button click delegation).
- `wire(root)` — instantiate Gridnav and attach `cancel`/`close` to the dialogs
  under `root`; safe to call repeatedly.
- Production entry: `initGlobal()` + `wire(document)` once.
- Playground: `initGlobal()` once, then `wire(preview)` after each `render()`.

Trade-off: a small refactor of the production entry point for a dev-only benefit.
Keeps a single source of truth for popup behavior (no playground fork).

### B. Playground-local re-init that tears down before re-wiring

Keep `main.ts` as-is; playground tracks and removes listeners before each render.
Rejected leaning: duplicates the wiring knowledge in two places and is exactly the
leak-prone path Option A designs away.

### C. Full-page iframe per cassette

Render each cassette into an `<iframe srcdoc>` that loads the real `main.js`.
Highest fidelity (identical to production, deep links + history isolated per
frame), but heaviest: needs the built `static/main.js`, loses direct HMR against
`main.ts` source, and complicates the Vite wiring. Overkill for the goal.

## Leaning

Option A. It is the least-duplication path and keeps popup behavior defined once.
The production-entry refactor is mechanical and low-risk (the behavior is already
covered by the docker walkthrough).

## Wrinkles to keep in mind (not blockers)

- Clicking a card writes `#book-N` into the playground URL and Back closes the
  popup — acceptable for a dev tool, but it mutates playground history/URL.
- `main.ts` queries `document` globally (`.books-grid`, `dialog.popup`). With one
  preview grid this is fine; `wire(root)` should scope its queries to `root` to
  stay correct if the playground ever shows more than one feed.
- The first-arrow-press nav guard already skips `input/select/textarea`, so the
  cassette dropdown will not steal arrow keys.

## Open questions

- Is docker-only popup verification actually painful enough to justify the
  production-entry refactor, or is the renderer's golden + unit coverage plus the
  occasional docker walkthrough sufficient?
- Should `wire(root)` scope all queries to `root` now (future-proofing) or assume
  a single grid?

## Rejected alternative: move production rendering to the client

Explored (2026-07-15) whether `index.html` should become a tiny shell that renders
in the browser instead of hono rendering at sync time. Three shapes, all rejected.
Recorded so the idea is not re-opened from scratch.

**Correct the mental model first.** Production has **no XML round-trip**. The
`folder-meta-sync` cascade builds `FeedModel` once and writes two artifacts from it
directly — `renderXml` → `feed.xml` (readers), `renderHtml` → `index.html`
(browsers). `parseFeed` (xml → model) runs **only** in the playground and cassette
tests, never in the production sync path. So the raw data (`FeedModel`) already goes
straight to the renderer; there is nothing to de-duplicate.

```
FeedModel ──renderXml──▶ feed.xml    (readers)
          └renderHtml──▶ index.html  (browsers)   ← rendered once, at sync, server-side
```

| Variant               | Idea                                                                         | Why rejected                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fetch feed.xml        | Shell fetches adjacent `feed.xml`, `parseFeed` + `renderHtml` client-side    | Re-creates the XSLT "browser transforms the feed" model we just removed. Blank first paint; no-JS = blank page; adds fetch + 503-during-sync client states.           |
| Inject FeedModel JSON | Sync writes shell + `<script>FeedModel</script>`; client `renderHtml(model)` | **Still writes a per-folder file** (no artifact saving), **same** `renderHtml` just deferred to the browser. Pure loss: blank paint, no-JS blank, zero gain over SSR. |
| Alpine / uhtml        | Client framework templates the page from data                                | A `<dialog>` still needs `showModal()` from JS regardless — the framework only relocates glue. Adds a dependency (Alpine ~15 KB) for no structural win.               |

**What none of them change:** the popup still needs `showModal()` from JS. Client
rendering is orthogonal to the popup problem that started this.

**Verdict.** Current `FeedModel → two renderers, direct, server-side` is already
minimal: no parse, static output, golden-tested, partial no-JS function. Every
client-render variant trades those away for one property — prod and playground
sharing a single render path. That unification is a deliberate architecture fork,
not a "simplification," and is **not** pursued. If it is ever wanted, it is its own
plan with eyes open about the first-paint / no-JS cost.

## Not doing now (except Option A)

Client-render variants: parked/rejected as above. Option A (wire the existing
`main.ts` driver into the playground) is the small, contained win and is being
implemented — it needs no architecture change and no new dependency.
