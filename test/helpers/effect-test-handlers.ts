import { Cause, Effect, Exit } from "effect";
import type { HandlerDeps } from "../../src/context.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService, type EffectFileSystemService } from "../../src/effect-file-system.ts";
import { CatalogueDeps, type EffectHandler } from "../../src/processing/effect-handler.ts";
import type { EventType } from "../../src/processing/types.ts";

export type TestHandlerDeps = HandlerDeps & { readonly signal?: AbortSignal };

/** Runs an Effect handler behind a Promise API. Interruption by `deps.signal` rejects with its reason. */
export async function runAsPromiseHandler(
  handler: EffectHandler,
  event: EventType,
  { signal, ...deps }: TestHandlerDeps,
  effectFs: EffectFileSystemService = effectFileSystemFromPromiseService(deps.fs),
): Promise<readonly EventType[]> {
  const exit = await Effect.runPromiseExit(
    handler(event).pipe(Effect.provideService(CatalogueDeps, deps), Effect.provideService(EffectFileSystem, effectFs)),
    {
      signal,
      uninterruptible: true,
    },
  );

  if (Exit.isSuccess(exit)) return exit.value;

  if (Cause.hasInterruptsOnly(exit.cause) && signal?.aborted) throw toError(signal.reason);

  throw toError(Cause.squash(exit.cause));
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
