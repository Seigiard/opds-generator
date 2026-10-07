# Lifecycle: startup, scans, resync, shutdown

Code: `src/lifecycle/`, `src/server.ts`.

## Rules and effects

- `transition(state, input)` in `src/lifecycle/transition.ts` is pure and owns every rule.
- Phases: `scanning`, `accepting` (no scan, processor busy), `settled` (no scan, processor empty), `stopping`.
- Inputs: scan requested/finished, processor busy/empty edges, reconcile tick, shutdown.
- It returns the next state plus effects: `start-scan`, `arm-reconcile-timer`, `skip-reconcile`, `abort-work`, `fail-startup`.
- `createLifecycle` in `lifecycle.ts` runs the effects with plain async. It takes a `CatalogueScanner`, the processor, and a `Clock`. It owns the consumer, scan tasks and reconcile timer, and logs a `Lifecycle` entry (from, to, input) per transition.
- `server.ts` only wires HTTP to the lifecycle.
- The lifecycle stays plain async. See `docs/lifecycle-execution-prototype.md` before you reopen the Effect-scope variant.

## Initial scan

- A failed initial scan fails fast: `scan-finished` with `ok: false` and kind `initial` enters `stopping` and emits `abort-work` then `fail-startup`.
- `start()` returns a promise that rejects with the scan's error. `server.ts` catches it, logs once, runs the shared stop path with the 8 s deadline, and exits 1. Docker then restarts the container.
- A failed resync or reconcile scan is only logged. The phase ends `settled` or `accepting`.
- `disk-scanner.ts` is the real scanner. `createDiskScanner({ filesPath, dataPath })` builds it for tests.
- nginx learns "initializing" from files, not from Bun. The seed `feed.xml` ends the 503s. The seed is written only after `/books` was read and planned, so a failed initial scan never reports healthy.

## Scans and reconciliation

- Reconciliation starts only in `settled`.
- A scan request during `scanning` sets one coalesced follow-up. Force flags are OR'd.
- `scanFiles` and `createSyncPlan` take an `AbortSignal`. They throw its reason per directory, per book and before returning.
- `BookDeleted` and `FolderDeleted` handlers do nothing when the source exists in `/books` at processing time (stale delete).

## Resync (ADR 0001)

- Resync repairs in place. It never wipes `/data`, so `feed.xml` never goes back to 503.
- It runs the same mtime-based sync plan as reconciliation. The plan deletes entries whose book is gone.
- `POST /resync?force=1` plans every book for reprocessing.
- `/resync` answers `202` always: `Resync started` when idle, `Resync queued` during a scan. It answers `503` only while stopping.

## Shutdown

- `stop()` enters `stopping`, aborts the active handler and scans, drops pending work and the follow-up scan, and awaits owned tasks.
- If `processor.start()` rejects before shutdown, lifecycle logs the failure once and calls `onFatal`; `server.ts` stops and exits 1 so Docker restarts the dead consumer. A rejection after shutdown is only observed and logged.
- `server.ts` races `stop()` against the 8 s deadline and exits 0.

## Status endpoint

Bun serves `GET /status` (lifecycle phase, scan, follow-up, processor snapshot) on localhost:3000 only. nginx does not proxy it. `test/e2e/nginx.test.ts` pins that.
