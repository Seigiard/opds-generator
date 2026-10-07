---
status: accepted
---

# Cascades replace the data watcher

A change to a book or folder must refresh every folder above it whose summary it changes, up to the root. This used to go through the data watcher. A handler wrote `entry.xml` or `_entry.xml`, inotify saw the write, `watcher.sh` posted it to `/events/data`, and only then did the parent refresh become catalogue work. Between the handler finishing and that post arriving, no catalogue work was pending or active, so the service could report Settled while the catalogue was still changing.

We decided that handlers return the parent refresh as a cascade, right after they publish. Book processing returns a refresh of its folder; a folder refresh returns a refresh of its parent, until the root. Since #21, a folder refresh returns its parent's refresh only when its `_entry.xml` summary changed, so the climb stops at the first unchanged folder. The data watcher, its `/events/data` endpoint and the work kinds it produced are removed. Nothing but the service writes to `/data`.

## Considered Options

- **Quiet period** (report Settled only after no work arrived for some time): rejected, because Settled becomes a guess that depends on inotify and HTTP latency.
- **Accept a false Settled**: rejected, because reconciliation starts on Settled and the `Lifecycle` log would report completion that is not real.

## Consequences

- Settled is exact: when processing reports no pending and no active work, nothing is on its way to it from `/data`.
- Edits made by hand inside `/data` no longer propagate. Stop the service and delete `/data` instead; the initial sync rebuilds it.
- Do not reintroduce a watcher on `/data` for propagation: it reopens the false Settled and the watcher-loop exclusions it needed.
