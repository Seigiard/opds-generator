---
status: accepted
---

# Resync repairs the catalogue in place

Resync used to delete everything in `/data` and then scan again, while the consumer could still be writing there. The books watcher also requests a resync by itself when inotify overflows, for example during a bulk copy of books. Each overflow therefore took the whole catalogue offline (nginx answers `503` until `feed.xml` exists again), and a resync that arrived during another scan was rejected with `409` and lost.

We decided that resync never clears `/data`. It runs the same sync plan as reconciliation, and that plan already removes catalogue entries whose book is gone. A forced resync reprocesses every book instead of only the changed ones. A resync that arrives while a scan is running is always accepted (`202`) and coalesced into one follow-up scan after the current scan, so `409` is no longer returned.

## Considered Options

- **Exclusive wipe** (accept only when Settled, else `409`): rejected, because overflow-triggered resyncs are lost exactly when changes are heavy.
- **Preemptive wipe** (stop the consumer, clear the queue, wipe, rescan): rejected, because the catalogue is still offline for the whole rebuild.

## Consequences

- Files in `/data` that belong to no `entry.xml` or `_entry.xml` are never removed. They are harmless, because feeds do not link to them. To remove them, stop the service and delete `/data`; the initial sync rebuilds it.
- Do not reintroduce a wipe "for safety": the e2e check that a resync never makes an existing `feed.xml` answer `503` guards this decision.
