# Processing module, cascades, sync lifecycle and execution prototype

Implements GitHub issues #20, #21, #15 and #16 in one branch, in dependency order:
#20 → (#21, #15) → #16. Each issue body holds the full scope and acceptance checks;
the items below cut them into commits that each leave the repository working.

Verification for every item (from `CLAUDE.md`): `bun run fix` (0/0), `bun --bun tsc --noEmit`,
`bun run test`, `npx knip`.

## Progress

Review base: b204f0b57ef62e1b96fbad59c7613c458653970c

- [x] P1 · #20 processing module boundary
      Done: one module owns queue, fixed handler registry, consumer loop, pending/active
      accounting, busy/empty edges and a status snapshot; `AppContext` exposes no `queue`/`handlers`;
      `register` removed; ordering tests unchanged and green; unit tests for edges (no false
      "empty" between cascade and active end, no edges after shutdown).
- [x] P2 · #20 cascades replace the data watcher (ADR 0002)
      Done: `bookSync` returns its folder refresh, `folderMetaSync` returns its parent refresh;
      `EntryXmlChanged`, `FolderEntryXmlChanged`, `parentMetaSync`, `folderEntryXmlChanged`,
      `data-adapter.ts`, `POST /events/data`, the `/data` inotifywait and their tests are gone;
      acceptance checks 1–5 of #20 pass through the module with real handlers on a temp fs.
- [x] P3 · #20 consumer cleanup, e2e rewrite, docs
      Done: no forced `Bun.gc(true)`; memory snapshot logged at `debug`; `test/e2e/event-logging.test.ts`
      rewritten for the `/books`-only path; memory gates green with unchanged limits; `CLAUDE.md`
      pipeline section, watcher-loop gotcha and project map updated.
- [ ] P4 · #21 refresh a parent only when the child summary changed
      Done: `folderMetaSync` writes `_entry.xml` and returns the parent refresh only on a content
      change (timestamp-insensitive if `opds-ts` embeds one); #21 acceptance checks 1–2 pass.
- [ ] P5 · #15 pure lifecycle transition and module
      Done: pure `transition(state, input)` + lifecycle module (scanner and clock injected) replace
      `isReady`/`isSyncing` and the detached tasks in `src/server.ts`; `Lifecycle` log entry per
      transition; internal `GET /status` on Bun (not proxied); reconciliation only when Settled
      (unit test on `transition`, #15 check 5).
- [ ] P6 · #15 resync in place, abortable scans, stale deletes, shutdown
      Done: resync never removes `/data`, mtime by default, `?force=1` reprocesses all; `202` +
      coalesced follow-up during Scanning (force OR'd), no `409`; `scanFiles`/`createSyncPlan` take
      an `AbortSignal`; `BookDeleted`/`FolderDeleted` no-op when the source exists; shutdown drops
      follow-up scan and awaits owned scans within 8 s; #15 checks 1–4 and 6 pass; `CLAUDE.md`
      and nginx/route docs updated.
- [ ] P7 · #16 plain async vs Effect prototype
      Done: an Effect 4.0.1 variant of the lifecycle module on the same `transition`; leak-probe,
      ownership, shutdown timing and code-size comparison written to
      `docs/lifecycle-execution-prototype.md` with a recommendation. If Effect wins: ADR + adopt it
      and drop the plain variant; otherwise drop the Effect variant and keep the findings doc.
