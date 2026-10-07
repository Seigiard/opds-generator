import { Cause, Data, Effect, Exit } from "effect";
import { err, ok, type Result } from "neverthrow";
import type { HandlerDeps } from "../../src/context.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService, type EffectFileSystemService } from "../../src/effect-file-system.ts";
import { CatalogueDeps, type EffectHandler, type EffectHandlers } from "../../src/processing/effect-handler.ts";
import type { EventType } from "../../src/processing/types.ts";
import { ownedPromise } from "../../src/utils/owned-promise.ts";

class TestHandlerFailed extends Data.TaggedError("TestHandlerFailed")<{ readonly cause: Error; readonly message: string }> {}

export type TestHandlerDeps = HandlerDeps & { readonly signal?: AbortSignal };

export type TestHandler = (event: EventType, deps: TestHandlerDeps) => Promise<Result<readonly EventType[], Error>>;

export type TestHandlers = Readonly<Partial<Record<EventType["_tag"], TestHandler>>>;

export function testEffectHandler(handler: TestHandler): EffectHandler {
  return Effect.fnUntraced(function* (event: EventType) {
    const deps = yield* CatalogueDeps;
    yield* EffectFileSystem;

    const result = yield* ownedPromise(
      (signal) => handler(event, { ...deps, signal }),
      (cause) => cause,
    ).pipe(Effect.interruptible, Effect.orDie);

    if (result.isErr()) return yield* new TestHandlerFailed({ cause: result.error, message: result.error.message });

    return result.value;
  });
}

export function toEffectTestHandlers(handlers: TestHandlers): EffectHandlers {
  const effectHandlers: Partial<Record<EventType["_tag"], EffectHandler>> = {};

  for (const [tag, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    // SAFETY: Object.entries widens Record<EventType["_tag"], ...> keys to string.
    effectHandlers[tag as EventType["_tag"]] = testEffectHandler(handler);
  }

  return effectHandlers;
}

/** Runs an Effect handler behind the Promise handler signature. Interruption by `deps.signal` returns its reason. */
export async function runAsPromiseHandler(
  handler: EffectHandler,
  event: EventType,
  { signal, ...deps }: TestHandlerDeps,
  effectFs: EffectFileSystemService = effectFileSystemFromPromiseService(deps.fs),
): Promise<Result<readonly EventType[], Error>> {
  const exit = await Effect.runPromiseExit(
    handler(event).pipe(Effect.provideService(CatalogueDeps, deps), Effect.provideService(EffectFileSystem, effectFs)),
    {
      signal,
      uninterruptible: true,
    },
  );

  if (Exit.isSuccess(exit)) return ok(exit.value);

  if (Cause.hasInterruptsOnly(exit.cause) && signal?.aborted) return err(toError(signal.reason));

  return err(toError(Cause.squash(exit.cause)));
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
