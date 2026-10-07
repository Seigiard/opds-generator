# External commands and Effect

Code: `src/utils/process.ts`.

## Command execution

- `src/utils/process.ts` owns command execution through Effect 4 scopes. Native extractors yield the Effect operations directly: `runCommand`, `runCommandText` (fail with `CommandFailed`), and `useTemporaryDirectory` (fails with `TemporaryDirectoryFailed`).
- `spawnWithTimeout`, `spawnWithTimeoutText`, `withTemporaryDirectory` are temporary Promise wrappers for legacy DJVU callers, the leak probe and process tests (#40). They take a `signal` and reject with the original cause. `runOwned(effect, signal)` runs an Effect for a legacy Promise caller and rejects with the abort reason after release. Remove them with their last caller.

## Archives

- `src/utils/archive-type.ts`: `detectArchiveType(path)` reads magic bytes as an Effect. Unreadable or unknown input is `null`; the handle closes on every path.
- `src/utils/zip.ts`: `listZipEntries`, `readZipEntry` run `zipinfo` / `unzip` through `runCommand`. Non-ZIP input, a missing entry, empty output, a nonzero exit, a timeout, or `CommandFailed` yield `[]` / `null`. Recovery uses `Effect.catchTag`, so interruption stays interruption.
- `src/utils/archive.ts`: `listArchiveEntries`, `readArchiveEntry`, `readArchiveEntryText` are the Effect dispatch for every archive type a format accepts. Formats read archives through them, never through `zip.ts` alone, so a book keeps every previously supported container (an EPUB packed as TAR still extracts). ZIP and TAR listings drop directory entries; 7z and RAR listings keep them.
  - 7z (`7zz`) and TAR (`tar`) run through `runCommand` with the same recovery as ZIP: `[]` / `null` on a failure, timeout or empty output; interruption stays interruption.
  - RAR runs node-unrar-js WASM inside `useTemporaryDirectory`. Extraction and the read of the extracted file cross uninterruptibly, so the directory is removed only after both finish. node-unrar-js routes every extractor through one shared WASM instance, so RAR work runs under a one-permit semaphore; overlapping extractions otherwise write into each other's directories.
- The Promise `listEntries` / `readEntry` / `readEntryText` in the same file run that dispatch through `runOwned` for legacy FB2 callers and the leak probe. Remove them with their last caller (#47).

## Effect scope

- `effect` is pinned to `4.0.1`. It owns command/resource ownership and, by ADR 0003, event processing. `server.ts` runs the Effect catalogue processor and Effect handlers.
- All catalogue handlers are Effects (`src/processing/handlers/*-effect.ts`) with tagged errors and Promise crossings through `ownedPromise`. Format extraction runs in the handler's fiber (ADR 0003).
- The vendored `anti-slop-effect` rules run at `error` on Effect-owned modules via the `.oxlintrc.json` override. `opds/no-direct-effect-promise` (project plugin in `tools/oxlint/opds/`) runs on the whole tree: a direct `Effect.promise` / `Effect.tryPromise` abandons its Promise on interruption. Use `ownedPromise` from `src/utils/owned-promise.ts`, pipe the crossing through `Effect.uninterruptible`, or put it inside `Effect.acquireRelease`. Where abandoning is intended, disable the line with the reason. When another module adopts Effect, add its path to the override; migrated format modules belong there too.
- Keep acquisition and release scoped, let native work outlive interruption, and preserve original errors at the Promise boundary.
- `docs/memory-leak-investigation.md` describes the old runtime. The Docker memory suites check current behavior.
