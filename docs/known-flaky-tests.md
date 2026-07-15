## Known Flaky Tests

Tests that fail intermittently for reasons unrelated to the code under test. On a single
unexplained failure in one of these suites, **re-run once** before investigating as a regression.
The plan/Verification-Contract flaky-test note refers here.

### 1. Docker unit suite — 1 test fails per full run — **FIXED 2026-07-15**

**Was:** `bun run test` (docker) intermittently failed one test per full run (~1 in 4), pinned to
`test/integration/memory-leak.test.ts`: first the "full chain" test on CI (PR #6, `2.7 KB/iter`
vs `< 1 KB/iter`), then reproduced locally in `saveCoverAndThumbnail` (`8.35`/`12.65 KB/iter` vs
`< 8`).

**Root causes found (three, layered):**

1. **Two-point RSS delta is noise-dominated.** `(rssAfter − rssBefore)/iters` swung from −37 MB
   to +4 MB across identical runs — a single allocator spike at the endpoint fakes a leak.
2. **Cross-test contamination.** Tests sharing one `bun test` process contaminate each other's
   RSS trend: leak-free code measured `+16…+24 KB/iter` mid-suite vs `−8 KB/iter` isolated
   (preceding tests leave mimalloc arenas decommitted; the next test's loop recommits them,
   reading as growth). No warmup length fixes this — a settle-detection warmup "settled" at
   0.13 MB/batch and the measurement still climbed 18 KB/iter.
3. **A real leak in `saveCoverAndThumbnail`** (see below) sat just under the 8 KB threshold and
   pushed it over intermittently.

**Fix:**

- Each scenario now runs in a **pristine subprocess** (`test/helpers/leak-probe.ts`), spawned per
  test by `memory-leak.test.ts` — kills contamination (2).
- The probe samples the RSS **floor** (min of several post-GC reads) every 10 iterations and
  reports both the **least-squares slope** and the two-point delta; the test asserts on
  `min(slope, twoPoint)` — a real leak drives both to the leak rate, while each noise mode
  (endpoint spike → two-point; mid-run hump → slope) fools only one. Kills (1) without loosening
  thresholds (`8 KB/iter` per-op, `1 KB/iter` chain — unchanged).
- The real leak (3) was fixed in `src/utils/image.ts`.

**Verified:** 3 consecutive runs of the leak file, 27/27 pass. Before the consensus metric,
`full-chain` slope alone jittered −0.2…+3.5 KB/iter across 9 probe runs while the two-point delta
stayed negative — hump-shaped RSS, no leak.

**Found & fixed while de-flaking — sharp `.clone()` leak:** `saveCoverAndThumbnail` built one
`sharp(buffer)` pipeline and `.clone()`d it twice (cover + thumb). Controlled A/B in fresh
processes: clone `+1.4…+7.2 KB/iter` (3 runs), two independent `sharp(buffer)` pipelines
`−7.5…−7.8 KB/iter` (3 runs); cache-off and fixed-filename variants still leaked, so it's the
clone, not the libvips cache. ~7 KB retained per book ≈ ~150 MB across a 21K-book sync — a
likely contributor to the residual RSS growth in `project_memory_leak_investigation`. Fixed by
dropping `.clone()` for two independent pipelines (decodes the buffer twice; cost negligible).

**Note:** `test/integration/memory-leak-handler.test.ts` (`< 5 KB/iter` over 100 iters) still
uses an in-process two-point delta and shares weaknesses (1)/(2). It has not been observed
flaking; if it does, port it to the probe pattern instead of re-running.

### 2. e2e — `Event Logging Phase 4: copy folder triggers FolderCreated + BookCreated`

**Symptom:** intermittent failure in `bun run test:e2e`.

**Cause:** inotify event-timing — the watcher occasionally races the assertion window when a folder
copy fans out into `FolderCreated` + `BookCreated` events.

**How to apply:** re-run `bun run test:e2e` before treating a single failure as a regression.

**CI scope (2026-07-15):** CI runs `bun run test:e2e:routing` (only `test/e2e/nginx.test.ts` — the
reader security/routing checks: CSP, cache, 206, `/resync` CSRF), **not** the full `test:e2e`. When
`test:e2e` was first added to CI (PR #6) this event-logging test flaked immediately and reddened an
otherwise-clean build, so CI was narrowed to the routing suite. `event-logging.test.ts` still runs
in local `bun run test:all`.

**Once this flake is fixed** (make the copy-fan-out assertion wait on the events deterministically
instead of a fixed window), **widen CI back to the full suite:** point the `Run e2e tests` step in
`.github/workflows/docker.yml` at `bun run test:e2e` again and drop `test:e2e:routing` from
`package.json` if nothing else uses it.

### Follow-up

Item 1 is fixed; item 2 (e2e event-logging inotify race) remains open — the re-run rule still
applies to it, and CI stays narrowed to `test:e2e:routing` until it is de-flaked.
