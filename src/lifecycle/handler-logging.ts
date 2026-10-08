import { Cause, Effect, Exit } from "effect";
import { join } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { log } from "../logging/index.ts";
import type { EventType } from "../processing/types.ts";

function eventPath(event: EventType): string | undefined {
  if ("path" in event) return event.path;

  if ("parent" in event && "name" in event) return join(event.parent, event.name);

  return undefined;
}

/** One entry per catalogue work item: start, completion with its cascades, or the failure. Interruption is not a failure. */
export function withHandlerLogs<E, R>(
  deps: HandlerDeps,
  event: EventType,
  work: Effect.Effect<readonly EventType[], E, R>,
): Effect.Effect<readonly EventType[], E, R> {
  return Effect.suspend(() => {
    const path = eventPath(event);
    const eventId = `${event._tag}:${path ?? "unknown"}:${Date.now()}:${Math.random().toString(36).substring(2, 7)}`;
    const startTime = Date.now();

    log.info("Consumer", "Handler started", { event_type: "handler_start", event_id: eventId, event_tag: event._tag, path });

    return work.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
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
                cascade_tags: cascades.map((cascade) => cascade._tag),
              });
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
        }),
      ),
    );
  });
}
