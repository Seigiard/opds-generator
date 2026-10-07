# External commands and Effect

Code: `src/utils/process.ts`.

## Command execution

- `src/utils/process.ts` owns command execution through Effect 4 scopes. Native extractors yield the Effect operations directly: `runCommand`, `runCommandText` (fail with `CommandFailed`), and `useTemporaryDirectory` (fails with `TemporaryDirectoryFailed`).
- `spawnWithTimeout`, `spawnWithTimeoutText`, `withTemporaryDirectory` are temporary Promise wrappers for legacy DJVU and archive callers (#40). They take a `signal` and reject with the original cause. `runOwned(effect, signal)` runs an Effect for a legacy Promise caller and rejects with the abort reason after release. Remove them with their last caller.

## Archives

- `src/utils/archive-type.ts`: `detectArchiveType(path)` reads magic bytes as an Effect. Unreadable or unknown input is `null`; the handle closes on every path.
- `src/utils/zip.ts`: `listZipEntries`, `readZipEntry`, `readZipEntryText` run `zipinfo` / `unzip` through `runCommand`. Non-ZIP input, a missing entry, empty output, a nonzero exit, a timeout, or `CommandFailed` yield `[]` / `null`. Recovery uses `Effect.catchTag`, so interruption stays interruption.
- `src/utils/archive.ts` keeps the Promise `listEntries` / `readEntry` / `readEntryText` for legacy comic and FB2 callers. Detection and the ZIP branch run the Effect operations above through `runOwned`; RAR, 7z and TAR keep their Promise paths until they move (#46).
- Commands time out after 15 s by default (`timeout` overrides).
- Timeout or cancellation sends SIGTERM, waits up to 1 s, then SIGKILL and waits for exit.
- Timeout returns empty stdout, `exitCode: -1`, `timedOut: true`. Cancellation rejects with the caller's abort reason after release.
- Stdout is file-backed. Stderr is ignored.
- Each command has its own scope: fd, child, output file, and temporary directory are acquired inside it and released when that command ends (result, spawn failure, timeout, or interruption). Never widen the scope to the whole book.
- `useTemporaryDirectory` keeps its work interruptible, so commands in it stop on interruption. Cross a native Promise that reads its files (sharp, unrar) with `Effect.uninterruptible`, so removal waits for it.
- `withTemporaryDirectory` callbacks await all work that uses their files. The Promise is uninterruptible, so native sharp/unrar work finishes before cleanup.
- Shutdown signals are installed before initial sync. The 8 s hard deadline stays. On expiry it logs unfinished work before exit.

## Effect scope

- `effect` is pinned to `4.0.1`. It owns command/resource ownership and, by ADR 0003, event processing. `server.ts` runs the Effect catalogue processor and Effect handlers.
- All catalogue handlers are Effects (`src/processing/handlers/*-effect.ts`) with tagged errors and Promise crossings through `ownedPromise`. Format extraction runs in the handler's fiber (ADR 0003).
- The vendored `anti-slop-effect` rules run at `error` on Effect-owned modules via the `.oxlintrc.json` override. `opds/no-direct-effect-promise` (project plugin in `tools/oxlint/opds/`) runs on the whole tree: a direct `Effect.promise` / `Effect.tryPromise` abandons its Promise on interruption. Use `ownedPromise` from `src/utils/owned-promise.ts`, pipe the crossing through `Effect.uninterruptible`, or put it inside `Effect.acquireRelease`. Where abandoning is intended, disable the line with the reason. When another module adopts Effect, add its path to the override; migrated format modules belong there too.
- Keep acquisition and release scoped, let native work outlive interruption, and preserve original errors at the Promise boundary.
- `docs/memory-leak-investigation.md` describes the old runtime. The Docker memory suites check current behavior.
