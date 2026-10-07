import { Cause, Context, Data, Effect, Exit } from "effect";
import { err, ok, type Result } from "neverthrow";
import type { HandlerDeps } from "../context.ts";
import type { Handler } from "./catalogue-processor.ts";
import type { EventType } from "./types.ts";

export class CatalogueDeps extends Context.Service<CatalogueDeps, Omit<HandlerDeps, "signal">>()("CatalogueDeps") {}

/** Constructors for catalogue events; the values stay plain `EventType` members. */
export const CatalogueEvent = Data.taggedEnum<EventType>();

class HandlerFailed extends Data.TaggedError("HandlerFailed")<{ readonly cause: Error; readonly message: string }> {}

/**
 * A handler failure is a tagged error; cancellation is fiber interruption, not a failure.
 * Handlers run uninterruptibly: a handler marks the phases shutdown may cancel with `Effect.interruptible`.
 * Interruption discards a result, so a phase that must finish once started stays outside those marks.
 */
export type HandlerError = Error & { readonly _tag: string };

export type EffectHandler = (event: EventType) => Effect.Effect<readonly EventType[], HandlerError, CatalogueDeps>;

export type EffectHandlers = Readonly<Partial<Record<EventType["_tag"], EffectHandler>>>;

/**
 * Runs a Promise that observes `signal`. On interruption it aborts the signal and waits for the
 * Promise to settle, so no handler or native work outlives its fiber. A rejection becomes `onError`.
 */
export function ownedPromise<A, E>(run: (signal: AbortSignal) => Promise<A>, onError: (cause: unknown) => E): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume, signal) => {
    const settled = run(signal).then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => resume(Effect.fail(onError(cause))),
    );

    // oxlint-disable-next-line opds/no-direct-effect-promise -- the cancel effect of Effect.callback runs uninterruptibly
    return Effect.promise(() => settled);
  });
}

/** Lifts a Promise handler into the Effect registry. A thrown handler becomes a defect, an `err` a `HandlerFailed`. */
export function fromPromiseHandler(handler: Handler): EffectHandler {
  return Effect.fnUntraced(function* (event: EventType) {
    const deps = yield* CatalogueDeps;

    const result = yield* ownedPromise(
      (signal) => handler(event, { ...deps, signal }),
      (cause) => cause,
    ).pipe(Effect.interruptible, Effect.orDie);

    if (result.isErr()) return yield* new HandlerFailed({ cause: result.error, message: result.error.message });

    return result.value;
  });
}

/** Runs an Effect handler behind the Promise handler signature. Interruption by `deps.signal` returns its reason. */
export async function runAsPromiseHandler(
  handler: EffectHandler,
  event: EventType,
  { signal, ...deps }: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  const exit = await Effect.runPromiseExit(handler(event).pipe(Effect.provideService(CatalogueDeps, deps)), {
    signal,
    uninterruptible: true,
  });

  if (Exit.isSuccess(exit)) return ok(exit.value);

  if (Cause.hasInterruptsOnly(exit.cause) && signal?.aborted) return err(toError(signal.reason));

  return err(toError(Cause.squash(exit.cause)));
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
