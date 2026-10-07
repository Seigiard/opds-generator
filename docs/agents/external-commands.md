# External commands and Effect

Code: `src/utils/process.ts`.

## Command execution

- `src/utils/process.ts` owns command execution through Effect 4 scopes. Native extractors yield the Effect operations directly: `runCommand`, `runCommandText` (fail with `CommandFailed`), and `useTemporaryDirectory` (fails with `TemporaryDirectoryFailed`).
- These are the only command and temporary-directory operations. There is no Promise wrapper and no abort-signal parameter: interruption of the calling fiber stops the command. A Promise caller outside the catalogue (a test, the leak probe) runs the Effect with `Effect.runPromise` / `Effect.runPromiseExit`.
- Commands time out after 15 s by default (`timeout` overrides).
- Timeout or cancellation sends SIGTERM, waits up to 1 s, then SIGKILL and waits for exit.
- Timeout returns empty stdout, `exitCode: -1`, `timedOut: true`. Interruption stays fiber interruption and ends after the child exits and its resources are released.
- Stdout is file-backed. Stderr is ignored.
- Each command has its own scope: fd, child, output file, and temporary directory are acquired inside it and released when that command ends (result, spawn failure, timeout, or interruption). Never widen the scope to the whole book.
- `useTemporaryDirectory` keeps its work interruptible, so commands in it stop on interruption. Cross a native Promise that reads its files (sharp, unrar) with `Effect.uninterruptible`, so removal waits for it.
- Run sibling commands with `Effect.all([...], { concurrency })`: a failure or interruption of one interrupts and awaits the others, so no child outlives the extraction. Recover with `Effect.catchTag` / `mapError`, which leave interruption alone (see `src/formats/djvu.ts`).
- Shutdown signals are installed before initial sync. The 8 s hard deadline stays. On expiry it logs unfinished work before exit.

## Archives

- `src/utils/archive-type.ts`: `detectArchiveType(path)` reads magic bytes as an Effect. Unreadable or unknown input is `null`; the handle closes on every path.
- `src/utils/zip.ts`: `listZipEntries`, `readZipEntry` run `zipinfo` / `unzip` through `runCommand`. Non-ZIP input, a missing entry, empty output, a nonzero exit, a timeout, or `CommandFailed` yield `[]` / `null`. Recovery uses `Effect.catchTag`, so interruption stays interruption.
- `src/utils/archive.ts`: `listArchiveEntries`, `readArchiveEntry`, `readArchiveEntryText` are the Effect dispatch for every archive type a format accepts. Formats read archives through them, never through `zip.ts` alone, so a book keeps every previously supported container (an EPUB packed as TAR still extracts). ZIP and TAR listings drop directory entries; 7z and RAR listings keep them.
  - 7z (`7zz`) and TAR (`tar`) run through `runCommand` with the same recovery as ZIP: `[]` / `null` on a failure, timeout or empty output; interruption stays interruption.
  - RAR runs node-unrar-js WASM inside `useTemporaryDirectory`. Extraction and the read of the extracted file cross uninterruptibly, so the directory is removed only after both finish. node-unrar-js routes every extractor through one shared WASM instance, so RAR work runs under a one-permit semaphore; overlapping extractions otherwise write into each other's directories.
  - The semaphore's guard is `archive.test.ts` "reads whose extractors are created together each return their own entry". It holds each real `createExtractorFromFile` result until a second extractor exists; without the semaphore a read returns `null`. Warm the WASM instance first: concurrent cold calls each create their own instance and never collide.

## Effect scope

- `effect` is pinned to `4.0.1`. It owns command/resource ownership and, by ADR 0003, event processing. `server.ts` runs the Effect catalogue processor and Effect handlers.
- All catalogue handlers are Effects (`src/processing/handlers/*-effect.ts`) with tagged errors and Promise crossings through `ownedPromise`. Format extraction runs in the handler's fiber (ADR 0003).
- The vendored `anti-slop-effect` rules run at `error` on Effect-owned modules via the `.oxlintrc.json` override. `opds/no-direct-effect-promise` (project plugin in `tools/oxlint/opds/`) runs on the whole tree: a direct `Effect.promise` / `Effect.tryPromise` abandons its Promise on interruption. Use `ownedPromise` from `src/utils/owned-promise.ts`, pipe the crossing through `Effect.uninterruptible`, or put it inside `Effect.acquireRelease`. Where abandoning is intended, disable the line with the reason. When another module adopts Effect, add its path to the override; migrated format modules belong there too.
- Keep acquisition and release scoped, let native work outlive interruption, and preserve original errors at the Promise boundary.
- `docs/memory-leak-investigation.md` describes the old runtime. The Docker memory suites check current behavior.
