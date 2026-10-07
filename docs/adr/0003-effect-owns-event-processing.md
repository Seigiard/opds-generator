---
status: accepted
---

# Effect owns event processing

Effect 4 was limited to command and resource ownership in `src/utils/process.ts`. Event processing stayed neverthrow + async/await after the Effect 3 runtime retained about 2.4 JS objects per event (`docs/memory-leak-investigation.md`). Handlers return `Result<readonly EventType[], Error>`, so failure classes are lost, and cancellation travels as an abort reason that every fallback `catch` must rethrow by convention.

We decided that Effect 4 owns event processing: the catalogue processor is a consumer fiber, and a handler is `(event) => Effect<readonly EventType[], HandlerError, CatalogueDeps | EffectFileSystem>` with one tagged error per failure class. Cancellation is fiber interruption. Handlers run uninterruptibly and mark the phases that shutdown may cancel with `Effect.interruptible`; every Promise crossing goes through `ownedPromise`, which waits for the Promise when interrupted. The HTTP endpoints and signal handlers in `server.ts` stay Promise-based. Lifecycle stays plain async (#16).

Effect also owns format extraction (#40). A format exposes one `extract(filePath)` returning `Effect<ExtractedBook, ExtractionFailed>`: metadata plus a cover or `null`, with no abort-signal parameter and no lazy cover method. It runs in the handler's fiber and yields the Effect-native command and temporary-directory operations, so interruption reaches a running command without a Promise bridge. Ordinary failures are recovered inside extraction (a cover failure keeps the metadata); `ExtractionFailed` means no usable result, and `bookSync` recovers it with the filename fallback. Interruption is never `ExtractionFailed`. The migration is expand-contract: PDF is native first (#41), and the remaining formats run through one temporary legacy adapter until each moves.

The prototype in #25 (`docs/effect-processing-prototype.md`) ran the processor, `bookSync`, cascade and shutdown suites against both variants with 0 failures, and kept JS objects per event at the plain level.

## Considered Options

- **Keep plain async**: rejected if this ADR is accepted, because failure classes, scoped resources and the cancellation convention stay unchecked.
- **Effect at the leaves only** (today's scope): rejected, because it adds a runtime without type gains where errors are handled; #16 found the same for lifecycle.

## Consequences

- `tsc` checks that failure tags exist and that acquired resources have a scope. It checks that every failure class is handled only where a caller narrows the error type; the handler registry widens it to `HandlerError`. It does not catch an Effect that is never yielded.
- `Effect.tryPromise` and `Effect.promise` must not be used in handlers: they abandon the Promise on interruption. `opds/no-direct-effect-promise` enforces this across the whole tree; only uninterruptible crossings and lines disabled with a reason pass. While the legacy format adapter exists, a legacy handler keeps the factory's signal for `getCover()`, so the adapter keeps its whole lifetime inside one `ownedPromise`. Native extractors keep no signal.
- The Effect processor reaches its RSS plateau later and a few MB higher. The consumer gates measure per event over batches of 100, so that warmup does not read as retention; the limit is unchanged.
