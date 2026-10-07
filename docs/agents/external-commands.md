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

- `effect` is pinned to `4.0.1` and limited to command and resource ownership. Event processing stays neverthrow + async/await with plain discriminated unions.
- Exception: the #25 prototype (`catalogue-processor-effect.ts`, `effect-handler.ts`, `handlers/book-sync-effect.ts`) is not wired into `server.ts`. ADR 0003 is proposed; see `docs/effect-processing-prototype.md`.
- The vendored `anti-slop-effect` rules run at `error` on Effect-owned modules via the `.oxlintrc.json` override. When another module adopts Effect, add its path to that override.
- Keep acquisition and release scoped, let native work outlive interruption, and preserve original errors at the Promise boundary.
- `docs/memory-leak-investigation.md` describes the old runtime. The Docker memory suites check current behavior.
