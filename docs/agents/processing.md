# Processing: adapters, handlers, cascades

Code: `src/processing/`, `src/context.ts`. Scheduling is the engine's: see `lifecycle.md` and `shared-sync-engine.md`.

## Flow

inotify (`watcher.sh`) → `POST /events/books` → `adaptBooksEvent` (raw → typed `EventType`) → a path hint to the engine → the engine's next pass declares work → Effect handlers.

- The watcher event is a hint. The pass reads the current source, so a repeated or late notice cannot publish stale facts.
- `engineOptions` (`src/lifecycle/initial-engine-catalogue.ts`) fixes the handler registry. `AppContext` exposes no queue or handlers.
- The engine's scheduler coalesces pending `FolderMetaSyncRequested` work by path and moves a repeated refresh behind later work. A refresh requested while the same refresh is active schedules one pending follow-up.
- Each work item logs `Handler started`, `Handler completed` (with cascade count) or `Handler failed` through `withHandlerLogs` (`handler-logging.ts`). Interruption is not a failure.

## Handlers

- A handler returns `Effect<readonly EventType[], HandlerError, CatalogueDeps | EffectFileSystem>`. The returned events are the cascade. See `src/processing/handlers/book-sync-effect.ts`.
- Handlers read `CatalogueDeps = Pick<AppContext, "config" | "logger" | "fs">` and `EffectFileSystem`.
- Cancellation is fiber interruption. Handlers run uninterruptibly and mark the phases shutdown may cancel with `Effect.interruptible`. Interruption discards a result, so a phase that must finish stays outside.
- A root or folder `index.html` write failure is a typed handler failure (`FolderBrowserPublishFailed`). `feed.xml` is still written.
- Source authority and cleanup wrap every handler (`engine-source-work.ts`): the path is re-observed first, absence or a confirmed source-kind change removes the associated outputs, a read error fails the work and keeps the previous result.
- Application processing versions live in `src/processing-versions.ts`. Bump `book` when extractor metadata, cover handling or book entry/link output changes. Bump `folder` when `src/render/*` feed/browser markup, folder-entry text or required static contract changes existing folder output. Pure CSS/JS changes under `ui/` do not need a bump unless existing `index.html` markup or linked asset contract must change too.

## Cascades

Cascades are the only propagation. Only `/books` is watched. The process never writes there, so a handler write cannot feed the watcher back. Check the `--exclude` in `src/watcher.sh` if you ever write under `/books`.

- Production passes declare `BookCreated`, `BookDeleted`, `FolderDeleted` and `FolderMetaSyncRequested`; watcher `FolderCreated` events are hints that schedule a pass, not live work. `bookSync` returns a folder refresh. Source-work cleanup removes associated outputs through the engine's confined removal for confirmed absence; OPDS adds the same confinement checks for source-kind changes and unsupported source replacements such as symlinks. A deletion whose source ancestor is now a non-directory removes the confined output, avoids re-observing through that ancestor, and refreshes no non-directory parent; orphan cleanup declares descendants before their folder.
- `folderSync`, `bookCleanup` and `folderCleanup` are retained compatibility/test seams for typed adapter events and leak probes. Production does not route work to them. Prefer `engine-source-work.ts`, `bookSync` and `folderMetaSync` for production deletion or folder-publication changes until those seams are removed with their tests.
- `folderMetaSync` returns a refresh of its parent only when its `_entry.xml` summary changed (ADR 0002). The comparison ignores the `<updated>` timestamp that opds-ts stamps on every Entry. The climb stops at the first folder whose count did not change. The folder's own `feed.xml` is always rewritten.
- A handler that writes or removes `entry.xml` or `_entry.xml` returns the refresh itself. Nothing observes `/data`.
- `bookSync` creates its download symlink before publishing `entry.xml`. Folder work is `FolderMetaSyncRequested`; it creates a missing derived directory, reads completed child entries, writes the folder's feed/page and updates `_entry.xml` for non-root folders.

## Effect processing

- In Effect handlers, cross a Promise boundary only through `ownedPromise`. `Effect.tryPromise` abandons the Promise on interruption, and the handler outlives `stop()`. The `opds/no-direct-effect-promise` rule enforces this.
- `src/effect-file-system.ts` is the Effect `FileSystemService`. It exposes tagged errno failures and wraps the current Promise filesystem. The adapter keeps the Promise service's unlink-first `symlink` behavior.
- `bookSync` yields the registry's `extract(filePath)` inside its interruptible preparation. `ExtractionFailed` keeps any existing entry, whether originally successful or filename fallback, and logs the extraction cause. This records stable damaged sources as current so future ordinary passes converge; transient extractor failures need a source change, processing-version bump or forced resync to retry. A first extraction with no published entry uses the filename fallback. Interruption leaves the previous entry and link untouched.
- Folder feed preparation propagates source and derived-entry read failures. It keeps the previous feed instead of publishing an empty replacement.
- Compound `.fb2.zip` sources select the existing FB2 registration; other extensions use the registry directly.
- Memory gates: `test/helpers/leak-probe.ts` has `consumer-enqueue-effect` (the engine's work scheduler), `handler-chain-effect`, `lifecycle-scan-effect` and `lifecycle-restart` (the production lifecycle). Limits and history: `docs/memory-oracle-investigation.md`.
- Extraction memory and stopping values: `docs/effect-extraction-baseline.md`. Prototype findings: `docs/effect-processing-prototype.md`.
