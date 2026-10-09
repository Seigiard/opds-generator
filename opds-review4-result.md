# OPDS review round 4 result

## Fixed in OPDS

- Separated retained failure identity for folder publication/cleanup from same-path book work.
- `FolderDeleted` now uses the same `folder:${DATA path}` failure key as `FolderMetaSyncRequested`.
- Same-path `BookCreated` success no longer clears a failed folder cleanup.
- Successful folder deletion now clears that folder's retained publication failure.
- Added watcher coverage for equal-stamp replacements through changed-path freshness hints.
- Strengthened missing-source cascade coverage so absent book work publishes nothing, reports no retained error, and independent folder work still completes.
- Removed a no-op DJVU stop-test helper and made failure-log capture explicit.
- Updated stale shared-engine lifecycle wording in docs.
- Split large touched files into smaller helper/test modules to avoid the local Docker bind-mount truncation issue observed during full Docker runs.

## Recorded, not worked around

- ENGINE-DEPENDENT: queued resync stalls after a recoverable startup failure because the engine supervisor does not retry pending work after recoverable opening failure.
- No OPDS workaround was added.
- Engine fix is expected in `@seigiard/sync-engine@0.5.4`; OPDS remains pinned to `@seigiard/sync-engine@0.5.3`.

## Verification

- `bunx --package bun@1.3.14 bun run fix` passed.
- `bun --bun tsc --noEmit` passed.
- `npx knip` passed.
- `bunx --package bun@1.3.14 bun run build:ui:check` passed.
- `bun run render:check` passed.
- `bun run render:pure` passed.
- `git diff --check` passed.
- `COMPOSE_PROJECT_NAME=opds49-r4-full4 bun run test` passed: 645 pass, 0 fail.
- `COMPOSE_PROJECT_NAME=opds49-r4-e2e TEST_PORT=18049 TEST_BASE_URL=http://localhost:18049 STARTUP_PORT=18082 bun run test:e2e` passed: 53 pass, 0 fail.
- Production image smoke passed with container health `healthy` and external `/feed.xml` plus `/index.html` responding on port `18050`.

## Finding disposition table

| Finding                                                                                                                                           | Disposition                                                                                                                                                                                                               | Test                                                                                                                                                                                                                                                           | Calibrated red/green                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bugs+impl-claude-1` major: folder-to-book cleanup failure is erased by same-path `BookCreated` success through the shared `source:` failure key. | Fixed in OPDS. `FolderDeleted` now uses `folder:${DATA path}` through `src/lifecycle/engine-failure-key.ts`; `BookCreated`/`BookDeleted` keep `source:${parent/name}`.                                                    | `test/integration/lifecycle/engine-recovery.test.ts`: `source kind-change cleanup refuses a state symlink alias` now submits failing `FolderDeleted` plus same-path successful `BookCreated` and expects `complete-with-errors` with retained `FolderDeleted`. | Red: throwaway mutation restoring `FolderDeleted` to the shared `source:` key makes the test fail because `BookCreated` clears the cleanup error and status becomes `complete`. Green: real tree passes the same test.                                                                                        |
| `bugs+impl-codex-2` minor: deleting a failed folder leaves its retained folder publication error active.                                          | Fixed in OPDS by the same `FolderDeleted` failure-key change. Successful deletion clears the retained `FolderMetaSyncRequested` error for that folder.                                                                    | `test/integration/lifecycle/engine-recovery.test.ts`: `successful folder deletion clears that folder's retained publication error` first creates a retained folder publication error, then deletes the folder and expects `complete` with no errors.           | Red: covered by the same old shared-key failure-key mutation; the retained `FolderMetaSyncRequested` error is not cleared by successful `FolderDeleted`. Green: real tree passes the same test.                                                                                                               |
| `arch+quality-claude-4` minor: `captureHandlerFailures()` only returned `[]` and no longer captured anything.                                     | Fixed in OPDS. Removed the helper, made `startProcessor(fixture, failureLogs)` require the caller-owned array, and kept failure capture inside the injected logger.                                                       | `test/integration/processing/djvu-stop.test.ts`: stop scenarios pass explicit `failures: string[]` to `startProcessor`; the cover-stop test asserts interruption logs no handler failure. TypeScript now rejects callers that omit the array.                  | Red: existing round 4 review identified this as a false-green test helper, not a runtime behavior. Calibration is type-level: removing the required argument would reintroduce the risk; `bun --bun tsc --noEmit` protects the required call contract. Green: real tree passes `djvu-stop.test.ts` and `tsc`. |
| `lean-codex-1` minor: absent-book test accepted retained errors and did not prove independent work ran.                                           | Fixed in OPDS tests. `withSession` exposes `status`, the absent-book scenario asserts `state: complete`, `errors: []`, no missing book output, and an old Poetry feed mtime being rewritten.                              | `test/integration/processing/cascade-through-engine-missing.test.ts`: `a reported book that is absent from the source publishes nothing and independent work still completes`.                                                                                 | Red: throwaway mutation that sends absent `BookCreated` into its handler makes the test fail with a retained `BookCreated` error. Green: real tree passes the same test.                                                                                                                                      |
| `bugs+impl-codex-1` major ENGINE-DEPENDENT: queued resync stalls after recoverable startup failure in pinned engine `0.5.3`.                      | Recorded only. No OPDS workaround. Engine supervisor fix belongs in `@seigiard/sync-engine@0.5.4`; OPDS pin remains `0.5.3`.                                                                                              | No local OPDS test was added because the behavior is owned by the released engine scheduler.                                                                                                                                                                   | Not calibrated locally. The result is intentionally recorded as engine-dependent and deferred to the engine release.                                                                                                                                                                                          |
| `docs+tests-codex-2` minor: completed migration plan still described the old plain-async lifecycle.                                               | Fixed in docs. `docs/plans/shared-synchronization-engine.md` now says ADR 0004 governs the shared engine lifecycle; `docs/agents/external-commands.md` names `createLiveEngineLifecycle` and the shared engine scheduler. | Documentation change reviewed by diff; no executable behavior.                                                                                                                                                                                                 | Not applicable: docs-only correction. Green: `bunx --package bun@1.3.14 bun run fix` and `npx knip` pass after the doc edit.                                                                                                                                                                                  |
| `docs+tests-codex-1` minor: no test protected watcher path forwarding from `createLiveEngineLifecycle.submit` to `session.notify([path])`.        | Fixed in OPDS tests. Added HTTP watcher scenario for equal-size, equal-mtime FB2 replacement so metadata check needs the changed-path hint.                                                                               | `test/integration/lifecycle/live-engine-catalogue.test.ts`: `HTTP watcher input repairs an equal-stamp book replacement through its changed path hint`.                                                                                                        | Red: throwaway mutation changing `session.notify([path])` to `session.notify([])` makes the equal-stamp watcher test fail because old metadata remains. Green: real tree passes the same test.                                                                                                                |

## Notes

- Earlier full Docker attempts failed because Docker served truncated versions of newly edited files inside the container. The final split files passed targeted Docker tests and the full Docker suite.

## 0.5.4 tarball pin

- Commit: `chore: TEMPORARY test against sync engine 0.5.4 tarball`.
- Source archive: `vendor/seigiard-sync-engine-0.5.4.tgz`, copied from `/var/folders/mg/mg22yjv17054nxmbq8_jkqnm0000gn/T/opencode/opds49-publish054-verified/seigiard-sync-engine-0.5.4.tgz`.
- Archive SHA256: `8189be5782457412210788e624f85e1b83957347536be88a28954de30d829e8d`.
- Lock integrity: `sha512-NgIpJK+d2GuLC5S4lCAigMazBVzFObP6+oF14Sz06vQgDpGB0PJyEN1m5WNhZts+xXRQp+hEmxCU6kw9Bqf5LQ==`.
- Host equality: unpacked archive diffed cleanly against `node_modules/@seigiard/sync-engine`; installed version `0.5.4`.
- Production-image equality: `opds49-r4-tarpin-prod` package diffed cleanly against the same unpacked archive; installed version `0.5.4`.
- Consumer check added: `test/integration/lifecycle/queued-resync-retry.test.ts` verifies a resync queued during recoverable warm-start failure retries without a second request.
- Gates: `fix`, `tsc`, `knip`, `build:ui:check`, `render:check`, `render:pure`, and `git diff --check` passed.
- Docker tests: first full run found one weak memory-gate RSS failure; isolated `memory-leak-handler.test.ts` then passed `2 pass, 0 fail`; final full run passed `646 pass, 0 fail`.
- e2e: `COMPOSE_PROJECT_NAME=opds49-r4-tarpin-e2e TEST_PORT=18054 TEST_BASE_URL=http://localhost:18054 STARTUP_PORT=18084 bun run test:e2e` passed `53 pass, 0 fail`.
- Production smoke: `opds49-r4-tarpin-smoke` became healthy and served `/feed.xml` and `/index.html`; container installed engine version `0.5.4`.
- Active leftover containers: none matching `opds49-r4-tarpin`.
- Leftover Docker images: `opds49-r4-tarpin-e2e-opds:latest`, `opds49-r4-tarpin-full-test:latest`, `opds49-r4-tarpin-full2-test:latest`, `opds49-r4-tarpin-memory-test:latest`, `opds49-r4-tarpin-prod:latest`, `opds49-r4-tarpin-queued-test:latest`, `opds49-r4-tarpin-smoke:latest`.
