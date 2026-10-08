# Lifecycle: startup, scans, resync, shutdown

Code: `src/lifecycle/`, `src/server.ts`, `src/catalogue-http.ts`. Package details and the engine seams: `shared-sync-engine.md`.

## Ownership

The packaged engine (`@seigiard/sync-engine`) owns scans, pass scheduling, reconciliation, dependency completion, freshness, retry after a failed first pass, and cooperative shutdown. OPDS owns domain work: extraction, rendering, source policy, and which outputs belong to which source. Nothing else in the process schedules passes or timers.

- `createLiveEngineLifecycle` (`live-engine-lifecycle.ts`) is the only production lifecycle. It is a Promise-facing transport adapter over an Effect scope. It translates HTTP input and the process lifetime. It holds no scan state, queue or timer.
- `startLiveEngineCatalogue` (`live-engine-catalogue.ts`) composes the production declaration: `engineOptions`, the periodic timer from `RECONCILE_INTERVAL`, and the `recovery` probe (root `feed.xml` and `index.html` already in DATA).
- `server.ts` wires HTTP to the lifecycle, runs housekeeping (`legacy-data.ts`), and races `stop()` against the 8 s deadline.
- The scope owns the output lease. The lease is held while the session is open, and released by scope close after owned work is joined. A failed first pass releases it while the session waits for a retry.

## Startup and the failure map

`start()` returns at once to the engine; the promise resolves when the first pass finished, or failed while output was usable.

- Without a usable root minimum (`feed.xml` and `index.html`), a failed first pass rejects `start()`. `onFatal` runs, `server.ts` stops and exits 1, and Docker restarts the container.
- With a usable minimum (prior output, or published this run), the process stays up. nginx keeps serving. `GET /status` reports the failure. The engine retries on `POST /resync`, on a watcher notice, or at the next `RECONCILE_INTERVAL` tick. A zero interval leaves requests as the only trigger.
- Cold start: the root minimum publishes first. Book and folder work follows and gates `completed`, not `available`.
- A source read failure is never deletion. Cleanup needs a fresh observation of absence.
- nginx learns "initializing" from files: missing `feed.xml` or `index.html` answers 503.
- The Docker `HEALTHCHECK` (and Compose probes) run `healthcheck.sh`: Bun reports `available`, and nginx serves `/feed.xml` and `/index.html`. Health means the minimum is available. It does not wait for verification.

## Scans and reconciliation

- Every pass scans the source, declares every applicable book and folder, and lets freshness decide what runs. `force` and watcher `changedPaths` reach freshness. Ordinary passes reuse results whose source stamp and processing version match.
- Every pass also looks for orphaned outputs in DATA (`orphans.ts`): a book or folder entry whose source is gone. Candidates become `BookDeleted` / `FolderDeleted` work. The source work re-observes each path and removes only on confirmed absence.
- Requests coalesce. A request during a pass guarantees one follow-up. Force is OR'd. Hints are unioned. This holds while the first pass runs too.
- `BookDeleted` and `FolderDeleted` do nothing when the source exists at processing time (stale delete).
- A watcher notice (`POST /events/books`) is a hint for the engine; repeated notices are not dropped.

## Resync (ADR 0001)

- Resync repairs in place. It never wipes `/data`, so `feed.xml` never goes back to 503.
- `POST /resync?force=1` bypasses freshness for every book.
- `/resync` answers `202`: `Resync started` when idle, `Resync queued` during a pass or the first pass. It answers `503` only after stop.

## Shutdown

- `stop()` closes admission, interrupts the scope, discards pending work and requests, and joins owned consumer work before the lease is released. Native Promise work is awaited. Extraction commands get SIGTERM, then SIGKILL after their grace period.
- Book preparation is interruptible. Once publication starts, the handler finishes its symlink and entry. A new instance replays unfinished work through successful-only freshness.
- Interrupted startup rejects `start()` without calling `onFatal`. `server.ts` treats that as shutdown and exits 0.
- The guarantee is cooperative. SIGKILL, the 8 s deadline and power loss can interrupt intermediate writes. Evidence: `shared-sync-engine.md`.

## Status endpoint

Bun serves `GET /status` on localhost:3000 only. nginx does not proxy it (`test/e2e/nginx.test.ts` pins that). Engine fields: `state`, `pass`, `followUp`, `failure`, `work`. Independent facts beside them:

| Fact                         | Meaning                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `available`, `availableFrom` | A usable minimum is in DATA. `prior-output`: both root files existed before verification. `minimum-publication`: this run wrote them. |
| `verifying`                  | The first pass is opening, or a pass is active or pending.                                                                            |
| `completed`                  | Required work drained and nothing is verifying.                                                                                       |
| `errors`                     | `{ source: "work" \| "pass", message }`. `work`: typed failures retained after completion. `pass`: a failed pass or first pass.       |

`entrypoint.sh` exits with the status of a Bun process that dies on its own (1 when Bun reports 0). A requested shutdown still exits 0. `test/e2e/startup-readiness.test.ts` pins the container exit code.
