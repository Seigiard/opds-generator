import { Data, Effect } from "effect";
import type { Result } from "neverthrow";
import type { HandlerDeps } from "../../src/context.ts";
import { EffectFileSystem } from "../../src/effect-file-system.ts";
import { CatalogueDeps, type EffectHandler, type EffectHandlers } from "../../src/processing/effect-handler.ts";
import type { EventType } from "../../src/processing/types.ts";
import { ownedPromise } from "../../src/utils/owned-promise.ts";

class TestHandlerFailed extends Data.TaggedError("TestHandlerFailed")<{ readonly cause: Error; readonly message: string }> {}

export type TestHandler = (event: EventType, deps: HandlerDeps) => Promise<Result<readonly EventType[], Error>>;

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
