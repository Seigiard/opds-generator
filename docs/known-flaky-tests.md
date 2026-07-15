## Known Flaky Tests

Tests that fail intermittently for reasons unrelated to the code under test. On a single
unexplained failure in one of these suites, **re-run once** before investigating as a regression.
The plan/Verification-Contract flaky-test note refers here.

### 1. Docker unit suite — 1 test fails per full run (~1 in 4 runs)

**Symptom:** `bun run test` (docker) reports `403 pass / 1 fail` (or similar N+1) on a full run;
a re-run of the exact same suite passes clean (`404 pass / 0 fail`).

**Observed:** 2026-07-15 during the native-dialog-popup refactor — one unidentified test failed on
the first full run, passed on immediate re-run with no code change in between. Also observed
2026-07-14.

**Status:** partially identified. One concrete instance seen on CI (PR #6, 2026-07-15):
`test/integration/memory-leak.test.ts` — "full chain: readEntry + saveCoverAndThumbnail" asserts
`< 1 KB/iter` RSS growth and reported `2.7 KB/iter`. RSS-per-iteration is noisy on CI runners
(GC/allocator timing — the mimalloc sensitivity in `project_memory_leak_investigation`), so it
crosses the 0-KB-target threshold intermittently without a real leak. Do **not** loosen the
threshold reflexively — it is a real leak guard; re-run first, and only investigate if the same
test fails twice with a code change that could plausibly affect the cover/image path.

**How to confirm it's the flake, not a regression:** re-run `bun run test`. If the second run is
green with no change, it was the flake. If the _same named test_ fails twice, investigate it.

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

Capture the failing test name across several full docker runs (e.g.
`bun run test 2>&1 | grep -E "\(fail\)"` looped) to confirm whether the memory-leak chain test below
is the _only_ unstable one or there are others. Until item 1 is de-flaked, the re-run rule stands.

### Fix candidate — `memory-leak.test.ts` "full chain" (the concrete instance of item 1)

**Why it flakes (root cause).** `measureLeak` derives the leak from a **single two-point RSS delta**:
`(rssAfter − rssBefore) · 1024 / ITERATIONS`. With `ITERATIONS = 300` and `MAX_CHAIN_LEAK_KB = 1`,
the whole run is allowed only `1 · 300 / 1024 ≈ 0.29 MB` of RSS growth. RSS is not a clean proxy for
heap retention: the allocator (mimalloc arenas) and `sharp`/libvips hold buffers non-deterministically,
so a single allocation spike at the moment `rssAfter` is sampled inflates the delta past the 0.29 MB
budget with no real leak. CI observed `2.7 KB/iter` (~0.79 MB delta) — noise, not a monotonic leak.

**Why not just raise the threshold.** `MAX_CHAIN_LEAK_KB = 1` encodes a real intent ("≈0 KB/iter, this
chain must not leak"). Bumping it to hide noise also blinds the guard to a genuine slow leak. Prefer a
metric that separates *trend* from *jitter*.

**Fix directions (pick one; 1 is the principled one):**

1. **Regression slope instead of a two-point delta.** Sample RSS every ~25 iterations across the run,
   fit a least-squares line, and assert on the *slope* (KB/iter) with a small tolerance. A true leak is
   a positive slope with low residual; allocator noise is a ~flat slope with variance. This is what
   "target 0 KB/iter" actually means and kills the single-spike sensitivity.
2. **Sample an RSS floor, not an instantaneous read.** Take several `Bun.gc(true)` + short-settle
   readings at the start and end and use the *minimum* of each window; the RSS floor is far more stable
   than one post-loop sample.
3. **Average the noise down.** Fixed ~0.3 MB jitter is `0.3 MB / ITERATIONS` per iter, so raising
   `ITERATIONS` (e.g. 1000) shrinks per-iter noise ~3× toward the 1 KB budget — cheapest, least
   principled, still a two-point metric.
4. **Ungate on CI.** If RSS on shared runners stays too noisy after 1–2, move the memory-leak suite to a
   local/nightly lane (as the event-logging e2e suite is kept out of the CI gate) rather than blocking PRs.

Owner note: this touches the memory-leak guard tracked in `project_memory_leak_investigation` — keep
the guard's teeth (option 1/2), do not silently widen the threshold.
