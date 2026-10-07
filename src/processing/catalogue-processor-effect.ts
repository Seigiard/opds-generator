import { Cause, Effect, Exit, Predicate, Queue } from "effect";
import { log } from "../logging/index.ts";
import type { HandlerDeps } from "../context.ts";
import { generateEventId, getEventPath, logMemorySnapshot, type CatalogueProcessor, type ProcessorStatus } from "./catalogue-processor.ts";
import { CatalogueDeps, type EffectHandlers } from "./effect-handler.ts";
import type { EventType } from "./types.ts";

interface EffectCatalogueProcessorOptions {
  readonly deps: Omit<HandlerDeps, "signal">;
  readonly handlers: EffectHandlers;
}

/** The Effect 4 variant of `createCatalogueProcessor` (issue #25): same contract, handlers are Effects. */
export function createEffectCatalogueProcessor({ deps, handlers }: EffectCatalogueProcessorOptions): CatalogueProcessor {
  const queue = Effect.runSync(Queue.unbounded<EventType>());
  // Coalescing keys of pending folder refreshes; a dirty key was submitted again while pending.
  const pendingKeys = new Set<string>();
  const dirtyKeys = new Set<string>();

  const busyListeners = new Set<() => void>();
  const emptyListeners = new Set<() => void>();

  let pending = 0;
  let active: ProcessorStatus["active"] = null;
  let busy = false;
  let shutdown = false;

  const emit = (listeners: Set<() => void>): void => {
    if (shutdown) return;

    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        deps.logger.error("Processor", "Edge listener threw", error);
      }
    }
  };

  const submit = (work: EventType | readonly EventType[]): void => {
    const items = "_tag" in work ? [work] : work;

    for (const item of items) {
      const key = coalescingKey(item);

      if (key !== undefined) {
        if (pendingKeys.has(key)) {
          dirtyKeys.add(key);
          continue;
        }

        pendingKeys.add(key);
      }

      Queue.offerUnsafe(queue, item);
      pending++;

      if (!busy) {
        busy = true;
        emit(busyListeners);
      }
    }
  };

  // A dirty folder refresh moves behind the work queued after it, as `SimpleQueue` does.
  const takeNext: Effect.Effect<EventType> = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      const key = coalescingKey(event);

      if (key === undefined) return event;

      if (dirtyKeys.delete(key)) {
        Queue.offerUnsafe(queue, event);
        continue;
      }

      pendingKeys.delete(key);

      return event;
    }
  });

  const settle = (): void => {
    active = null;

    if (pending === 0 && busy) {
      busy = false;
      emit(emptyListeners);
    }
  };

  const runWork = Effect.fnUntraced(function* (event: EventType) {
    const path = getEventPath(event);
    const eventId = generateEventId(event, path);
    const startTime = Date.now();

    log.info("Consumer", "Handler started", { event_type: "handler_start", event_id: eventId, event_tag: event._tag, path });

    const handler = handlers[event._tag];

    if (!handler) {
      deps.logger.warn("Consumer", "No handler found", { event_tag: event._tag });

      return;
    }

    const exit = yield* Effect.exit(Effect.uninterruptible(handler(event)));
    const duration = Date.now() - startTime;

    if (Exit.isSuccess(exit)) {
      const cascades = exit.value;

      log.info("Consumer", "Handler completed", {
        event_type: "handler_complete",
        event_id: eventId,
        event_tag: event._tag,
        path,
        duration_ms: duration,
        cascade_count: cascades.length,
      });

      if (cascades.length > 0) {
        log.info("Consumer", "Cascades generated", {
          event_type: "cascades_generated",
          event_id: eventId,
          event_tag: event._tag,
          path,
          cascade_count: cascades.length,
          cascade_tags: cascades.map((e) => e._tag),
        });
        submit(cascades);
      }

      return;
    }

    if (Cause.hasInterruptsOnly(exit.cause)) return;

    if (Cause.hasDies(exit.cause)) {
      deps.logger.error("Consumer", "Unexpected handler throw", Cause.squash(exit.cause), { event_tag: event._tag });

      return;
    }

    log.error("Consumer", "Handler failed", Cause.squash(exit.cause), {
      event_type: "handler_error",
      event_id: eventId,
      event_tag: event._tag,
      path,
      duration_ms: duration,
    });
  });

  const consume = Effect.gen(function* () {
    const event = yield* takeNext;
    pending--;
    active = { kind: event._tag, path: getEventPath(event) ?? null };
    yield* runWork(event);
    // Cascades are already pending here, so the active slot clears into a non-empty state.
    settle();
    logMemorySnapshot();
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        active = null;
      }),
    ),
    Effect.forever,
    Effect.provideService(CatalogueDeps, deps),
  );

  const start = async (signal: AbortSignal): Promise<void> => {
    deps.logger.info("Consumer", "Started processing events");
    signal.addEventListener("abort", () => (shutdown = true), { once: true });
    shutdown = signal.aborted;

    if (signal.aborted) return;

    // Abort interrupts the consumer fiber; the promise settles once the active handler has.
    const exit = await Effect.runPromiseExit(consume, { signal });

    // A defect outside a handler (the logger, the queue) ends the loop; reject as the plain consumer does.
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause);
  };

  return {
    submit,
    start,
    status: () => ({ pending, active }),
    onBusy: (listener) => {
      busyListeners.add(listener);

      return () => busyListeners.delete(listener);
    },
    onEmpty: (listener) => {
      emptyListeners.add(listener);

      return () => emptyListeners.delete(listener);
    },
  };
}

function coalescingKey(event: EventType): string | undefined {
  return Predicate.isTagged(event, "FolderMetaSyncRequested") ? `${event._tag}:${event.path}` : undefined;
}
