---
status: accepted
---

# Effect owns event processing

Effect 4 was limited to command and resource ownership in `src/utils/process.ts`. Event processing stayed neverthrow + async/await after the Effect 3 runtime retained about 2.4 JS objects per event (`docs/memory-leak-investigation.md`). Handlers return `Result<readonly EventType[], Error>`, so failure classes are lost, and cancellation travels as an abort reason that every fallback `catch` must rethrow by convention.

We decided that Effect 4 owns event processing: the catalogue processor is a consumer fiber, and a handler is `(event) => Effect<readonly EventType[], HandlerError, CatalogueDeps>` with one tagged error per failure class. Cancellation is fiber interruption. Handlers run uninterruptibly and mark the phases that shutdown may cancel with `Effect.interruptible`; every Promise crossing goes through `ownedPromise`, which waits for the Promise when interrupted. The HTTP endpoints and signal handlers in `server.ts` stay Promise-based. Lifecycle stays plain async (#16).

The prototype in #25 (`docs/effect-processing-prototype.md`) ran the processor, `bookSync`, cascade and shutdown suites against both variants with 0 failures, and kept JS objects per event at the plain level.

## Considered Options

- **Keep plain async**: rejected if this ADR is accepted, because failure classes, scoped resources and the cancellation convention stay unchecked.
- **Effect at the leaves only** (today's scope): rejected, because it adds a runtime without type gains where errors are handled; #16 found the same for lifecycle.

## Consequences

- `tsc` checks that failure tags exist and that acquired resources have a scope. It checks that every failure class is handled only where a caller narrows the error type; the handler registry widens it to `HandlerError`. It does not catch an Effect that is never yielded.
- `Effect.tryPromise` and `Effect.promise` must not be used in handlers: they abandon the Promise on interruption. `anti-slop-effect/no-direct-effect-promise-in-handlers` enforces `ownedPromise` in Effect handler modules. An object that keeps a signal, such as a format handler, lives inside one `ownedPromise`.
- The Effect processor reaches its RSS plateau later and a few MB higher. The consumer gates measure per event over batches of 100, so that warmup does not read as retention; the limit is unchanged.
