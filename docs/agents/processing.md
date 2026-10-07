# Processing: adapters, queue, consumer, handlers

Code: `src/processing/`, `src/context.ts`.

## Flow

Adapters (raw inotify → typed `EventType`) → `CatalogueProcessor.submit` → Effect queue and consumer fiber → Effect handlers.

- `createEffectCatalogueProcessor({ deps, handlers })` fixes the handler registry at construction. `AppContext` exposes no queue or handlers.
- `status()` returns `{ pending, active }` and feeds only `GET /status`.
- Cascades join pending before the active slot clears.
- The processor coalesces pending `FolderMetaSyncRequested` events by path and moves dirty refreshes behind later queued work.

## Handlers

- A handler returns `Effect<readonly EventType[], HandlerError, CatalogueDeps | EffectFileSystem>`. The returned events are the cascade. See `src/processing/handlers/book-sync-effect.ts`.
- Handlers read `CatalogueDeps = Pick<AppContext, "config" | "logger" | "fs">` and, where ported to typed filesystem calls, `EffectFileSystem`.
- Cancellation is fiber interruption. Handlers run uninterruptibly and mark the phases shutdown may cancel with `Effect.interruptible`.
- An `index.html` render failure is logged and does not block `feed.xml`.

## Cascades

Cascades are the only propagation. Only `/books` is watched. The processor never writes there, so a handler write cannot feed the watcher back. Check the `--exclude` in `src/watcher.sh` if you ever write under `/books`.

- Folder refreshes travel as cascades. `bookSync`, `bookCleanup`, `folderCleanup` and `folderSync` return a refresh of their folder or parent. `folderSync` returns both its own and its parent's.
- `folderMetaSync` returns a refresh of its parent only when its `_entry.xml` summary changed (ADR 0002). The comparison ignores the `<updated>` timestamp that opds-ts stamps on every Entry. The climb stops at the first folder whose count did not change. The folder's own `feed.xml` is always rewritten.
- A handler that writes or removes `entry.xml` or `_entry.xml` returns the refresh itself. Nothing observes `/data`.
- `folderSync` lists the new folder and cascades `BookCreated` / `FolderCreated` for what is already inside. It skips the root and any book whose `entry.xml` exists. `inotifywait -r` adds its watch to a new folder only after the create event, so files copied in meanwhile raise no event of their own. Without the listing they wait for reconciliation.

## Busy and empty edges

- `onBusy` fires when work enters an idle processor. `onEmpty` fires when the last pending event (cascades included) finishes. Both are silent after shutdown.
- These edges drive the lifecycle phase. Periodic reconciliation starts only in `settled`, so a lost `empty` edge blocks reconciliation.
- The processor never forces GC per event. The periodic memory snapshot logs at `debug` level.

## Effect processing

- `server.ts` runs `createEffectCatalogueProcessor` with `bookSyncEffect`, `folderSyncEffect`, `folderMetaSyncEffect`, `bookCleanupEffect`, and `folderCleanupEffect`. Findings and go/no-go: `docs/effect-processing-prototype.md`.
- Tests use the Effect processor only. `test/helpers/leak-probe.ts` has `consumer-enqueue-effect`, `handler-chain-effect`, and `lifecycle-scan-effect` memory gates.
- In Effect handlers, cross a Promise boundary only through `ownedPromise`. `Effect.tryPromise` abandons the Promise on interruption, and the handler outlives `stop()`.
- `src/effect-file-system.ts` is the Effect `FileSystemService`. It exposes tagged errno failures and can wrap the current Promise filesystem for the processor/test boundary. Unlike the Promise service, `symlink` does not unlink the old path first; the caller decides how to recover.
- An object that keeps a signal (a format handler keeps the factory's for `getCover()`) lives inside one `ownedPromise`. Each bridge has its own signal, so a second bridge leaves the kept one dead.
- Effect handlers run uninterruptibly. Mark the phases shutdown may cancel with `Effect.interruptible`; interruption discards a result, so a phase that must finish stays outside.
