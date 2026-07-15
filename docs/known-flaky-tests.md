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

**Status:** unidentified. The failing test is not stable across runs, so it has not been pinned to a
specific file. Suspected timing/ordering sensitivity in the docker unit run rather than a real
assertion defect.

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

Item 1 is worth pinning down: capture the failing test name across several full docker runs (e.g.
`bun run test 2>&1 | grep -E "\(fail\)"` looped) to identify which test is unstable, then decide
whether to add a retry, fix an ordering assumption, or mark it. Until then, the re-run rule stands.
