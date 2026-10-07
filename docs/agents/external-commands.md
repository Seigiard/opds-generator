# External commands and Effect

Code: `src/utils/process.ts`.

## Command execution

- `src/utils/process.ts` owns command execution through Effect 4 scopes behind a Promise interface: `spawnWithTimeout`, `spawnWithTimeoutText`, `withTemporaryDirectory`. PDF/DJVU and archive code call these helpers.
- Commands time out after 15 s by default (`timeout` overrides).
- Timeout or cancellation sends SIGTERM, waits up to 1 s, then SIGKILL and waits for exit.
- Timeout returns empty stdout, `exitCode: -1`, `timedOut: true`. Cancellation rejects with the caller's abort reason after release.
- Stdout is file-backed. Stderr is ignored.
- Acquire fd, child, and output inside the scope, so a spawn failure releases them too.
- `withTemporaryDirectory` callbacks await all work that uses their files. The Promise is uninterruptible, so native sharp/unrar work finishes before cleanup.
- Shutdown signals are installed before initial sync. The 8 s hard deadline stays. On expiry it logs unfinished work before exit.

## Effect scope

- `effect` is pinned to `4.0.1`. It owns command and resource ownership, and by ADR 0003 event processing too. The migration is in progress: `server.ts` still runs the plain neverthrow processor and handlers.
- New processing code follows ADR 0003: Effect handlers with tagged errors, Promise crossings through `ownedPromise`. The Effect processor and `bookSyncEffect` exist beside the plain code (`docs/effect-processing-prototype.md` has the migration plan).
- The vendored `anti-slop-effect` rules run at `error` on Effect-owned modules via the `.oxlintrc.json` override. `opds/no-direct-effect-promise` (project plugin in `tools/oxlint/opds/`) runs on the whole tree: a direct `Effect.promise` / `Effect.tryPromise` abandons its Promise on interruption. Use `ownedPromise` from `src/utils/owned-promise.ts`, pipe the crossing through `Effect.uninterruptible`, or put it inside `Effect.acquireRelease`. Where abandoning is intended, disable the line with the reason. When another module adopts Effect, add its path to the override.
- Keep acquisition and release scoped, let native work outlive interruption, and preserve original errors at the Promise boundary.
- `docs/memory-leak-investigation.md` describes the old runtime. The Docker memory suites check current behavior.
