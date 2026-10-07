# Lifecycle execution: plain async vs Effect scopes

Issue #16. Decision: **keep plain async.** The Effect variant was built, measured and deleted.

## Setup

Both variants use the same pure `transition(state, input)` in `src/lifecycle/transition.ts`. They share the same interface (`start`, `requestScan`, `accepting`, `status`, `stop`) and the same `CatalogueScanner`, `Clock` and `CatalogueProcessor` types. Only execution differs.

- **Plain async**: `src/lifecycle/lifecycle.ts`. One `AbortController`, a `Set` of owned promises, `stop()` aborts and awaits `Promise.allSettled`.
- **Effect 4.0.1**: a `Scope`; every scan, the timer and the consumer is a fiber from `Effect.forkIn(task, scope, { startImmediately: true })`. `stop()` closes the scope. Closing interrupts fibers newest first, so scans stop before the consumer. A helper (`ownedPromise`) turns interruption into "abort the signal, then wait for the promise to settle". The scanner, clock and processor stay promise-based, so Effect only wraps them.

The full existing `test/unit/lifecycle/lifecycle.test.ts` suite ran against both (parametrized with `describe.each`): 30 tests, 0 failures.

Measurements ran in Docker (`docker-compose.test.yml`, Bun 1.4.2) with the existing leak-probe gates: warmup 300, 600 measured operations, full GC after each, limits unchanged (1 KB RSS and 0.5 objects per cycle). One operation is 10 cycles, so the gate divides by 10.

- `lifecycle-scan`: one running lifecycle; each cycle is a resync scan that finds one folder refresh, runs it through the consumer and settles.
- `lifecycle-restart`: each cycle builds a fresh lifecycle, starts it, settles and stops it.
- Shutdown: 15 rounds per scenario. The scan or handler cleans up 20 ms after its signal aborts, so about 20 ms is the floor.

## Numbers

| Measure                                                           | Plain async          | Effect scope                                                                                         |
| ----------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| Memory gate, repeated scans (KB RSS per cycle, 4 runs; limit 1.0) | 0.12 to 0.34         | 0.40 to **1.02** (one red run)                                                                       |
| Memory gate, start/scan/stop (KB per cycle, 4 runs)               | 0.07 to 0.29         | 0.03 to 0.25                                                                                         |
| JS objects per cycle (limit 0.5)                                  | 0.0015               | 0.0015 to 0.0018                                                                                     |
| Long run, 24 000 scans (slope KB per op)                          | -1.3, -1.0 (flat)    | 0.09, then a -11 drop (flat)                                                                         |
| RSS plateau after warmup                                          | about 94 to 97 MB    | about 97 to 100 MB (+3 to 5 MB)                                                                      |
| Stop during initial scan (median / max ms)                        | 23.7 / 25.5          | 25.1 / 32.9                                                                                          |
| Stop during resync, with queued follow-up                         | 24.1 / 30.4          | 25.9 / 27.9                                                                                          |
| Stop during active handler                                        | 24.0 / 30.0          | 24.5 / 26.5                                                                                          |
| Stop with a scan that ignores its signal (80 ms task)             | waits 76 ms          | waits 79 ms                                                                                          |
| Work left after stop (scans, handlers, open sleeps)               | 0                    | 0                                                                                                    |
| Lines of lifecycle execution code                                 | 179 (`lifecycle.ts`) | 136 (`lifecycle-effect.ts`)                                                                          |
| Effect concepts a reader must hold                                | none                 | `Scope`, `forkIn` + `startImmediately`, `uninterruptibleMask`, `onInterrupt`, `Exit`, `Cause.squash` |

The red run: `lifecycle-scan-effect` read 1.018 KB per cycle against the limit of 1. The two longer runs show the cause is a later plateau, not growth: both variants stay flat over 24 000 scans, and Effect sits a few MB higher. I did not raise the limit.

## Ownership findings

What can outlive its owner:

| Item                                     | Plain async                                                                          | Effect scope                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Scan task                                | Owned by `own()`. A scan started outside `own()` would escape; this is a convention. | Owned by the scope by construction of `fork`. Same convention: only the `fork` helper uses the scope. |
| Consumer (`processor.start`)             | Owned; aborted by the shared signal.                                                 | Owned; interrupt aborts its own signal and waits.                                                     |
| Reconcile timer                          | Loop ends on abort. The sleep removes its abort listener in both exits.              | Fiber interrupted by scope close. The sleep is still `clock.sleep`, so the same listener code runs.   |
| Task that ignores its signal             | `stop()` waits for it. Only the 8 s deadline in `server.ts` bounds it.               | Same: `onInterrupt` waits for it. Same bound.                                                         |
| `processor.onBusy` / `onEmpty` listeners | Never unsubscribed.                                                                  | Never unsubscribed. They are silent after shutdown, and the processor has the same lifetime.          |
| Finalizers / bookkeeping per scan        | One `Set` entry, removed in `finally`.                                               | One scope finalizer per fiber, removed when the fiber ends. The 24 000-scan run shows no growth.      |

Tests: `test/unit/lifecycle/shutdown.test.ts` counts scans, handlers and open sleeps still running after `stop()`. It reads 0 in every scenario for both variants.

Behavior differences found while porting, all in the Effect variant:

- A default `forkIn` starts the child later. `stop()` straight after `start()` then never called the scanner. The test "stop during a scan" went red (`Expected length: 1, Received length: 0`). `startImmediately: true` fixed it.
- A failed scan logged the whole `Cause` as JSON until it was passed through `Cause.squash`.
- The Effect variant needs its own interruption bridge, because a plain `Effect.tryPromise` abandons the promise on interrupt. That is the part plain async gets for free from `await`.

## Recommendation

Keep plain async. Effect gives no measurable win here:

- Shutdown time and leftover work are equal. The floor is the cleanup time of the work, not the runtime.
- Memory is equal in the long run, with a few MB more resident and a gate that reads at the limit once in four runs.
- Ownership is equal. Both variants own every scan, timer and consumer. Neither owns the processor listeners.
- Effect saves 43 lines, but the reader must hold six Effect concepts and a custom interruption bridge. The plain version needs `AbortController`, a `Set` and `allSettled`.
- Effect would only own a thin wrapper: scanner, clock and processor stay promise-based. A real gain needs those to become Effects too, which is a larger change than this prototype and a different question.

Revisit if scans, the processor and handlers move to Effect as a whole. `@typeonce/effect-machine` was not needed: the pure `transition` was enough.

## What stays in the tree

- This document.
- `test/unit/lifecycle/shutdown.test.ts`: shutdown time and leftover work for the plain variant.
- `test/integration/memory-leak-lifecycle.test.ts` and the `lifecycle-scan` / `lifecycle-restart` scenarios in `test/helpers/leak-probe.ts`.