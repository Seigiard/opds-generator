# Event processing: plain async vs Effect 4

Issue #25. Recommendation: **go** (see [Recommendation](#recommendation)). The prototype stays in the tree beside the plain code. `server.ts` still runs the plain processor.

## Setup

Both variants meet the same `CatalogueProcessor` interface: `submit`, `start(signal)`, `status`, `onBusy`, `onEmpty`. The same rules apply to both: pending folder refreshes are coalesced, cascades are submitted before the active slot clears, and abort drops pending work and its cascades.

- **Plain async**: `src/processing/catalogue-processor.ts` with `SimpleQueue`, and `src/processing/handlers/book-sync.ts`. Handlers return `Promise<Result<readonly EventType[], Error>>` and receive an `AbortSignal`.
- **Effect 4.0.1**:
  - `src/processing/catalogue-processor-effect.ts`: a `Queue.unbounded`, a consumer fiber with `Effect.forever`, and the coalescing keys kept beside the queue.
  - `src/processing/effect-handler.ts`: the handler type `(event) => Effect<readonly EventType[], HandlerError, CatalogueDeps>`, the `CatalogueDeps` service, the `ownedPromise` bridge, and adapters in both directions (`fromPromiseHandler`, `runAsPromiseHandler`).
  - `src/processing/handlers/book-sync-effect.ts`: `bookSync` as an Effect with tagged errors.
- Shared by both: `getEventPath`, `generateEventId`, `logMemorySnapshot`, and `bookEntryXml` (the OPDS entry of one book, extracted from the plain `bookSync`).

Tests that run against both variants (`describe.each`). The suite bodies are unchanged; only the factory is a parameter:

| Suite                                                           | Tests per variant | Result     |
| --------------------------------------------------------------- | ----------------- | ---------- |
| `test/unit/processing/catalogue-processor.test.ts`              | 16                | 0 failures |
| `test/unit/processing/handlers/book-sync.test.ts`               | 10                | 0 failures |
| `test/integration/processing/cascade-through-processor.test.ts` | 10                | 0 failures |
| `test/unit/processing/processor-shutdown.test.ts` (new)         | 2                 | 0 failures |
| `test/integration/memory-leak-handler.test.ts`                  | 2                 | 0 failures |

In the cascade suite the Effect variant runs the Effect `bookSync` through the Effect processor. The other handlers are plain handlers lifted with `fromPromiseHandler`.

## Numbers

Docker (`docker-compose.test.yml`), `effect@4.0.1`. The memory gates use `test/helpers/leak-probe.ts` with unchanged limits: own process per run, warmup 300, 600 measured operations, full GC after each. The consumer scenarios now run 100 events per operation and divide by 100 (see [The consumer gate](#the-consumer-gate)). "Retained" is the gate value: the smaller of slope and two-point estimate.

| Measure                                                                          | Plain async                   | Effect 4                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `consumer-enqueue`, retained KB per event, 100 events per op (4 runs; limit 1.0) | 0.006, 0.009, 0.055, 0.006    | -0.006, -0.053, -0.062, -0.014                                            |
| Same, with 1 KiB retained per event (calibration, 4 runs)                        | 1.12, 1.12, 0.97, 1.13        | 1.12, 1.10, 1.11, 1.08                                                    |
| `consumer-enqueue`, JS objects per event (limit 0.5)                             | 0.0001                        | 0.0001                                                                    |
| `consumer-enqueue`, one event per op, warmup 300 (old method, 4 runs)            | 0.65, 0.79, **1.09**, 0.98    | **2.57**, 0.73, **2.39**, **2.69**                                        |
| `consumer-enqueue`, one event per op, JIT off, logging off, 2 runs               | -0.33, -0.48                  | -0.05, 0.00                                                               |
| `handler-chain`, retained KB per book (4 runs; limit 5)                          | -5.21, -2.12, 0.70, -2.89     | -18.59, -4.86, -0.69, -2.34                                               |
| `handler-chain`, JS objects per book (limit 0.5)                                 | 0.0017 to 0.0033              | 0.0033                                                                    |
| `handler-chain`, long run, 2400 books: RSS first → last third mean               | 159.2 → 150.7 MB (slope -5.0) | 155.8 → 143.1 MB (slope -8.6)                                             |
| Stop during an active handler (median / max ms, 15 rounds, 20 ms cleanup)        | 23.7 / 28.3                   | 28.3 / 30.9                                                               |
| Stop with 50 pending cascades (median / max ms)                                  | 25.3 / 29.2                   | 26.9 / 31.6                                                               |
| Work left after stop (handlers running, pending work started)                    | 0, 0                          | 0, 0                                                                      |
| Processor lines (factory function + coalescing queue)                            | 159 + 84 (`SimpleQueue`)      | 192 (coalescing inside) + 76 (`effect-handler.ts`, shared)                |
| `bookSync` lines (entry builder shared, 41 lines)                                | 92                            | 118: four error classes and their props (21), the owned extraction helper |
| Effect concepts a reader must hold                                               | none                          | see below                                                                 |

The four `handler-chain` Effect runs and its long run measured the first port of the extraction, with two bridges (trap 3 below). After the fix, one gate run in `bun run test` read slope -3.28 and two-point 1.83 KB per book, 0.003 objects: green.

Effect concepts in the prototype: `Effect.gen` / `Effect.fn` / `fnUntraced`, `Context.Service` and `provideService`, `Data.TaggedError` and `catchTag`, `Queue`, `Exit` and `Cause` (`hasInterruptsOnly`, `hasDies`, `squash`), `Effect.callback` (the bridge), `interruptible` / `uninterruptible`, `runPromiseExit` with `signal` and `uninterruptible`, `Predicate.isTagged`, `Data.taggedEnum`.

### The consumer gate

With one event per measured operation, the Effect consumer read red: 2.39 to 2.69 KB per event in 3 of 4 runs against the limit of 1. The limit stays. The cause is warmup, not retention:

- JS objects per event stay at 0.03 to 0.07 at one event per operation (0.0001 in the batched gate), far under the limit. The Effect 3 runtime kept about 2.4 objects per event.
- A 2400-event run grows about 1.2 MB over the first ~600 events and is then flat. A 6000-event run stays on a plateau and then releases memory.
- With the JIT off, both variants are flat (-0.05 and 0.00 KB per event for Effect). This points to JIT code memory for the deeper Effect call paths, not to retained data.

A longer warmup does not give a usable gate at one event per operation. With warmup 600 a clean run still read 1.14; with warmup 900 and 1200 clean runs were green, but 1 KiB retained per event read 1.0 or more in only 1 of 8 runs. The plain gate has the same weakness: clean runs read up to 1.09, and retained memory read 0.58 in 1 of 4 runs. At one event per operation, 1 KB per event is below the RSS resolution of the probe.

The fix applies the method `queue-cycle` already uses: 100 events per operation, divided by 100. The old reason for one event per operation (the consumer forced a GC per event) no longer holds. Warmup 300 then covers 30 000 events, which is past the JIT warmup. Clean runs read at most 0.055 KB per event for both variants; 1 KiB retained per event reads 0.97 to 1.13. `memory-oracle-calibration.test.ts` now proves the red side on `consumer-enqueue-effect`, with 4 KiB retained per event so that the control reads well above the limit.

All runs, mine and the gate's, ran with the consumer's info logs off: `docker-compose.test.yml` sets `LOG_LEVEL=warn`, and probe children inherit it. An earlier draft of this document blamed logging for the spread between my first runs and the gate; that was wrong. The spread is run-to-run variance at one event per operation, the same weakness the paragraph above describes. The 2400- and 6000-event plateau runs in the bullets above used the old one-event method.

`handler-chain` hides the same few MB in its noise: sharp and child processes move RSS by 10 to 20 MB per run.

### Type safety

Each pair was checked with `tsc --noEmit` against the real modules (`bookSync`, `bookSyncEffect`, `CatalogueDeps`).

| Defect                               | Plain async                                                                                                | Effect 4                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A failure class left unhandled       | Compiles. The error is `Error`; nothing lists the classes.                                                 | **Rejected** where the caller narrows the error: after `catchTags({ BookStatFailed, BookDataDirFailed })`, `EntryPublishFailed` is not assignable to `never` (TS2322). The registry type `EffectHandler` widens every handler error to `HandlerError`, so the processor itself logs any failure without this check. |
| A misspelt failure class             | Compiles: `result.error.name === "BookStatFaild"` never matches.                                           | **Rejected**: `catchTag("BookStatFaild")` is not one of `"BookStatFailed" \| "BookDataDirFailed" \| "EntryPublishFailed"` (TS2345).                                                                                                                                                                                 |
| A resource with no release           | Compiles: `await mkdtemp(...)` with no `rm`.                                                               | **Rejected**: `acquireRelease` needs `Scope`; `runPromise` without `Effect.scoped` fails with `Effect<string, never, Scope>` (TS2345).                                                                                                                                                                              |
| A missing dependency                 | Rejected: `bookSync(event)` without `deps` (TS2554).                                                       | Rejected: `runPromise(bookSyncEffect(event))` without `CatalogueDeps` (TS2345). **No difference.**                                                                                                                                                                                                                  |
| A forgotten `await` / `yield*`       | Compiles. Oxlint `no-floating-promises` is configured but needs type-aware mode, so it does not fire here. | Compiles: an Effect that is not yielded is a value that never runs. **No difference.**                                                                                                                                                                                                                              |
| Cancellation swallowed by a fallback | Compiles. Every fallback `catch` must call `signal.throwIfAborted()` by convention.                        | Not a compile-time check, but impossible by construction: interruption is not in the error channel, so `catchTag` and `catch` cannot swallow it.                                                                                                                                                                    |

Snippets:

```ts
// Plain: compiles, and the "BookStatFaild" branch never runs.
const result = await bookSync(event, deps);
if (result.isErr() && result.error.name === "BookStatFaild") return "retry later";

// Effect: TS2322, EntryPublishFailed is not handled.
const handled: Effect.Effect<readonly EventType[], never, CatalogueDeps> = bookSyncEffect(event).pipe(
  Effect.catchTags({ BookStatFailed: () => Effect.succeed([]), BookDataDirFailed: () => Effect.succeed([]) }),
);

// Effect: TS2345, Scope is not provided.
const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp("/tmp/opds-")),
  (dir) => Effect.promise(() => rm(dir, { recursive: true })),
);
Effect.runPromise(tempDir);
```

### Development experience for agents

- `anti-slop-effect` findings on the first draft of the new code: 3. Two `no-manual-tag-comparison` (`event._tag === …`, fixed with `Predicate.isTagged`) and one `no-manual-tagged-construction` (a literal cascade event, fixed with `Data.taggedEnum<EventType>()`). One general `require-readable-spacing`. All fixed; the final code has 0.
- Effect 3 API written by mistake and caught by `tsc`: 0 in this prototype. The triage probe had already fixed the Effect 4 names (`Context.Service`, `Effect.fn`, `Queue.offerUnsafe`).
- Three Effect traps came up. `tsc` catches none of them:
  1. **`Effect.tryPromise` and `Effect.promise` abandon the Promise on interruption.** They abort the signal and return at once; the handler keeps running after `stop()`. The prototype needs its own bridge, `ownedPromise` (`Effect.callback` whose cancel effect waits for the Promise). The new shutdown test proves the bridge matters: with the wait removed, the Effect variant stops in 1 ms and leaves 15 handlers running in 15 rounds (red), against 0 with it.
  2. **Interruption discards a result even after an uninterruptible tail.** With `uninterruptible(publish)` as the last step, the existing test "finishes download publication when cancellation arrives during entry write" went red: both writes finished, but the handler reported the interruption instead of success. The fix is the inverse default: handlers run uninterruptibly, and a handler marks the phases shutdown may cancel with `Effect.interruptible` (`bookSyncEffect` marks its preparation). The processor and `runAsPromiseHandler` both run handlers that way. A processor test now guards that a cascade returned after abort in the uninterruptible part is dropped; it goes red when `runWork` itself is made uninterruptible.
  3. **A format handler keeps the factory's signal.** The first port wrapped the factory and `getCover()` in two `ownedPromise` calls. Each bridge has its own signal, so the signal the PDF, DJVU, EPUB and comic handlers keep for `getCover()` was already dead: shutdown could not kill a running cover command (`pdftoppm`, `ddjvu`, `unzip`, `7z`), which then ran up to its 15 s timeout. Code review found it; no test did. The fix runs the factory, `getMetadata` and `getCover` in one `ownedPromise`. The rule for the migration: an object that keeps a signal lives inside one owned Promise.

## Behavior differences found while porting

- Cancellation moves out of the error channel. The plain `bookSync` returns the abort reason as a `Result` err, and every fallback `catch` in the extraction path must rethrow it. In the Effect `bookSync` cancellation is interruption, and the extraction fallback is a plain `catchTag("ExtractionFailed")`.
- `ExtractionFailed` is recovered inside `bookSync`, so the handler's error type is exactly `BookStatFailed | BookDataDirFailed | EntryPublishFailed`.
- A thrown Promise handler becomes a defect (`Cause.hasDies`) and logs "Unexpected handler throw", as the plain processor does. An `err` result becomes `HandlerFailed` and logs "Handler failed".
- `runAsPromiseHandler` returns the abort reason as the error when the run was interrupted by the caller's signal. The cancellation test of `bookSync` expects exactly this.

## Promise boundary inventory

121 boundaries: processing 31, lifecycle 13, scanner 10, formats 27, utils 24 (`process.ts` 9 of them already Effect), `FileSystemService` in `context.ts` 11, `server.ts` 5.

- **Errors swallowed into fallbacks.** Extraction in `bookSync` (any failure becomes the filename title; a failing `getCover` also drops metadata that was read). Every format factory (`null`), `archive.ts` (`[]` / `null`), `image.ts` (`false`). `folderMetaSync`: a read error writes an empty feed, any `stat` error counts as "source deleted", an `index.html` write error is dropped. `scanner.ts` swallows any non-abort `readdir` error. `FileSystemService.exists` and the unlink before `symlink` swallow every errno.
- **Cancellation by convention.** Every catch in `archive.ts`, the format factories, `extractMetadataAndCover` and `runOwned` must call `throwIfAborted()` before its fallback. `comic.ts` and `djvu.ts` rethrow after `Promise.allSettled`. `bookSync` and `folderSync` return the abort reason as a `Result` err; the processor checks `signal.aborted` after the handler returns.
- **Errors that become `unknown` or plain `Error`.** `process.ts` (`catch: (cause) => cause`), the initial scan error in `lifecycle.ts`, `new Error("Queue take failed unexpectedly")` in the processor (drops the original), and the `instanceof Error ? … : new Error(String(…))` wrap in every handler.
- **No signal at all.** `FileSystemService`, `folderMetaSync`, `bookCleanup`, `folderCleanup`, the sharp pipelines, `mobi` (reads the whole file), `txt`, plain `fb2`, `detectArchiveType`.
- **Stays Promise-based.** The `Bun.serve` `fetch` handler (`POST /events/books`, `POST /resync`, `GET /status`), the SIGTERM/SIGINT handlers and the shutdown deadline in `server.ts`. `runOwned` in `process.ts` is the existing Effect-to-Promise bridge and becomes unnecessary once its callers are Effects.
- Two likely bugs found on the way, not fixed here: `pdf.ts` `extractCover` has no `try`, so a `pdftoppm` spawn failure reaches `bookSync` and drops the PDF's metadata; `lifecycle.ts` `void task.finally(…)` leaves the derived Promise without a handler, so a rejecting `processor.start` is an unhandled rejection.

## Recommendation

Go, against the decision rule "not worse than plain on memory, shutdown and code size, and gives type safety and a better development experience":

- **Memory: not worse.** No retention: JS objects per event and per book stay at the plain level. At one event per operation the Effect consumer read 0.03 to 0.07 objects per event, at least 33× under the Effect 3 figure of about 2.4; the batched gate reads 0.0001 for both variants. RSS reaches its plateau later and a few MB higher, which is the accepted tradeoff. The consumer gate now measures per event over batches of 100 and is green for both variants, with a calibrated red side (see [The consumer gate](#the-consumer-gate)). It does not cover retention per drain (one event arriving at an idle processor): the plain processor has that through `lifecycle-scan`, the Effect processor has no such gate yet.
- **Shutdown: equal for the processor.** 2 to 5 ms slower median, 0 leftover work in both; the floor is the cleanup time of the work. The shutdown test drives lifted Promise handlers. Stop during the Effect `bookSync` cover extraction was not measured: it relies on the single owned extraction Promise from trap 3, which no test exercises.
- **Code size: about equal, slightly worse.** The processor needs no unrolled queue, and the shared bridge and adapters cost about the same. `bookSync` grows from 92 to 118 lines, mostly error classes and their message props.
- **Type safety: better on failures and resources.** Exhaustive failure handling (where a caller narrows the error), checked failure tags, and scoped resources are compile-time checks only in Effect. Dependencies and forgotten awaits are equal. Cancellation leaves the error channel, so the documented "rethrow the abort through every fallback" convention goes away.
- **Development experience: better, with three traps to fence in code.** The `anti-slop-effect` rules caught the manual-tag habits at once. All three traps (`tryPromise` abandons work; interruption beats a finished result; a kept signal outlives its bridge) are invisible to `tsc`. The migration must make `ownedPromise` and the "uninterruptible handler, interruptible phases" rule the only way handlers cross a Promise boundary, and keep the shutdown test that proved the first trap.

The decision record is `docs/adr/0003-effect-owns-event-processing.md` (status: proposed).

## Migration plan

Each step is one PR. The plain variant keeps working until step 5.

1. **Settle the consumer gate.** Done in this prototype: both consumer gates run 100 events per operation, and the calibration test covers `consumer-enqueue-effect`.
2. **Handler bridge as the only Promise crossing.** Add an oxlint rule (or extend `anti-slop-effect`) that forbids `Effect.tryPromise` / `Effect.promise` in handler modules, so every crossing goes through `ownedPromise`. Add the handler modules to the `anti-slop-effect` override.
3. **Port the folder handlers** (`folderSync`, `folderMetaSync`, `bookCleanup`, `folderCleanup`), one PR each or two, with tagged errors per failure class. Keep `describe.each` over both variants for their suites. Decide per swallow listed in the inventory whether it stays a recovered tagged error or becomes a failure.
4. **`FileSystemService` as an Effect service** with typed errno failures, so the handlers stop wrapping `fs` Promises one by one. `process.ts` drops `runOwned` for callers that are Effects.
5. **Switch `server.ts` to the Effect processor**, behind the gates from step 1, `handler-chain-effect`, and a per-drain gate for the Effect processor (`lifecycle-scan` built on it; `buildLifecycle` in the probe hard-codes the plain processor today). Remove `fromPromiseHandler`, the plain processor, `SimpleQueue` and the plain handlers in the same PR, and the `describe.each` parameters with them.
6. **Format extraction** (optional, separate decision): factories and `archive.ts` as Effects, which removes the `throwIfAborted` convention there too. Lifecycle stays plain async (#16) unless its scanner, clock and processor are all Effects by then.

## What is in the tree

- Prototype code: `src/processing/catalogue-processor-effect.ts`, `src/processing/effect-handler.ts`, `src/processing/handlers/book-sync-effect.ts`, and `bookEntryXml` / the exported helpers in the plain modules.
- Tests: `describe.each` over both variants in the suites listed in [Setup](#setup), `test/helpers/effect-variants.ts`, and the new `test/unit/processing/processor-shutdown.test.ts`.
- Probe scenarios `handler-chain-effect` (gated in `memory-leak-handler.test.ts`) and `consumer-enqueue-effect` (gated in `memory-leak-runtime.test.ts`, calibrated in `memory-oracle-calibration.test.ts`).
