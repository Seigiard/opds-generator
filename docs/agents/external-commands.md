# External commands and Effect

Code: `src/utils/process.ts`.

## Command execution

- `src/utils/process.ts` owns command execution through Effect 4 scopes. Native extractors yield the Effect operations directly: `runCommand`, `runCommandText` (fail with `CommandFailed`), and `useTemporaryDirectory` (fails with `TemporaryDirectoryFailed`).
- `spawnWithTimeout`, `spawnWithTimeoutText`, `withTemporaryDirectory` are temporary Promise wrappers (#40). No `src/` module calls them any more; the leak probe and the process and queue-consumer tests still do. They take a `signal` and reject with the original cause. `runOwned(effect, signal)` runs an Effect for a legacy Promise caller and rejects with the abort reason after release. Remove them with their last caller.
- Commands time out after 15 s by default (`timeout` overrides).
- Timeout or cancellation sends SIGTERM, waits up to 1 s, then SIGKILL and waits for exit.
- Timeout returns empty stdout, `exitCode: -1`, `timedOut: true`. Cancellation rejects with the caller's abort reason after release.
- Stdout is file-backed. Stderr is ignored.
- Each command has its own scope: fd, child, output file, and temporary directory are acquired inside it and released when that command ends (result, spawn failure, timeout, or interruption). Never widen the scope to the whole book.
- `useTemporaryDirectory` keeps its work interruptible, so commands in it stop on interruption. Cross a native Promise that reads its files (sharp, unrar) with `Effect.uninterruptible`, so removal waits for it.
- Run sibling commands with `Effect.all([...], { concurrency })`: a failure or interruption of one interrupts and awaits the others, so no child outlives the extraction. Recover with `Effect.catchTag` / `mapError`, which leave interruption alone (see `src/formats/djvu.ts`).
- `withTemporaryDirectory` callbacks await all work that uses their files. The Promise is uninterruptible, so native sharp/unrar work finishes before cleanup.
- Shutdown signals are installed before initial sync. The 8 s hard deadline stays. On expiry it logs unfinished work before exit.

## Archives

- `src/utils/archive-type.ts`: `detectArchiveType(path)` reads magic bytes as an Effect. Unreadable or unknown input is `null`; the handle closes on every path.
- `src/utils/zip.ts`: `listZipEntries`, `readZipEntry` run `zipinfo` / `unzip` through `runCommand`. Non-ZIP input, a missing entry, empty output, a nonzero exit, a timeout, or `CommandFailed` yield `[]` / `null`. Recovery uses `Effect.catchTag`, so interruption stays interruption.
- `src/utils/archive.ts`: `listArchiveEntries`, `readArchiveEntry`, `readArchiveEntryText` are the Effect dispatch for every archive type a format accepts. Formats read archives through them, never through `zip.ts` alone, so a book keeps every previously supported container (an EPUB packed as TAR still extracts). ZIP and TAR listings drop directory entries; 7z and RAR listings keep them.
  - 7z (`7zz`) and TAR (`tar`) run through `runCommand` with the same recovery as ZIP: `[]` / `null` on a failure, timeout or empty output; interruption stays interruption.
  - RAR runs node-unrar-js WASM inside `useTemporaryDirectory`. Extraction and the read of the extracted file cross uninterruptibly, so the directory is removed only after both finish. node-unrar-js routes every extractor through one shared WASM instance, so RAR work runs under a one-permit semaphore; overlapping extractions otherwise write into each other's directories.
- The Promise `listEntries` / `readEntry` in the same file run that dispatch through `runOwned` for the leak probe's `list-entries` / `read-entry` scenarios. Remove them with their last caller (#47).

## Effect scope

- `effect` is pinned to `4.0.1`. It owns command/resource ownership and, by ADR 0003, event processing. `server.ts` runs the Effect catalogue processor and Effect handlers.
- All catalogue handlers are Effects (`src/processing/handlers/*-effect.ts`) with tagged errors and Promise crossings through `ownedPromise`. Format extraction runs in the handler's fiber (ADR 0003).
- The vendored `anti-slop-effect` rules run at `error` on Effect-owned modules via the `.oxlintrc.json` override. `opds/no-direct-effect-promise` (project plugin in `tools/oxlint/opds/`) runs on the whole tree: a direct `Effect.promise` / `Effect.tryPromise` abandons its Promise on interruption. Use `ownedPromise` from `src/utils/owned-promise.ts`, pipe the crossing through `Effect.uninterruptible`, or put it inside `Effect.acquireRelease`. Where abandoning is intended, disable the line with the reason. When another module adopts Effect, add its path to the override; migrated format modules belong there too.
- Keep acquisition and release scoped, let native work outlive interruption, and preserve original errors at the Promise boundary.
- `docs/memory-leak-investigation.md` describes the old runtime. The Docker memory suites check current behavior.
