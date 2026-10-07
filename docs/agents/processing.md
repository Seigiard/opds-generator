# Processing: adapters, queue, consumer, handlers

Code: `src/processing/`, `src/context.ts`.

## Flow

Adapters (raw inotify → typed `EventType`) → `CatalogueProcessor.submit` → its `SimpleQueue` and consumer loop → handlers.

- `createCatalogueProcessor({ deps, handlers })` fixes the handler registry at construction. `AppContext` exposes no queue or handlers.
- `status()` returns `{ pending, active }` and feeds only `GET /status`.
- Cascades join pending before the active slot clears.
- The queue coalesces pending `FolderMetaSyncRequested` events by path and moves them behind later queued work.

## Handlers

- A handler returns `Result<EventType[], Error>`. The returned events are the cascade. See `src/processing/handlers/book-sync.ts`.
- A handler receives `HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">` plus an optional `signal`. The consumer passes its shutdown signal. `bookSync` forwards it to format factories and archive commands.
- Reset state flags in `finally`. Shut down through `AbortController` and `Promise.allSettled` (see `src/lifecycle/lifecycle.ts`).
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
