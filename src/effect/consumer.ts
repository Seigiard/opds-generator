import { Effect } from "effect";
import { heapStats } from "bun:jsc";
import { log } from "../logging/index.ts";
import type { EventType } from "./types.ts";
import { EventQueueService, HandlerRegistry, LoggerService } from "./services.ts";

function generateEventId(event: EventType, path: string | undefined): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 7);
  return `${event._tag}:${path ?? "unknown"}:${timestamp}:${random}`;
}

function getEventPath(event: EventType): string | undefined {
  if ("path" in event && typeof event.path === "string") return event.path;
  if ("parent" in event && "name" in event) return `${event.parent}/${event.name}`;
  if ("parent" in event && typeof event.parent === "string") return event.parent;
  return undefined;
}

const processEvent = (event: EventType) =>
  Effect.flatMap(EventQueueService, (queue) =>
    Effect.flatMap(HandlerRegistry, (registry) =>
      Effect.flatMap(LoggerService, (logger) => {
        const path = getEventPath(event);
        const eventId = generateEventId(event, path);
        const startTime = Date.now();

        log.info("Consumer", "Handler started", {
          event_type: "handler_start",
          event_id: eventId,
          event_tag: event._tag,
          path,
        });

        const handler = registry.get(event._tag);
        if (!handler) {
          return logger.warn("Consumer", "No handler found", { event_tag: event._tag });
        }

        return handler(event).pipe(
          Effect.map((cascades) => ({ ok: true as const, cascades })),
          Effect.catchAll((error) => {
            const duration = Date.now() - startTime;
            log.error("Consumer", "Handler failed", error, {
              event_type: "handler_error",
              event_id: eventId,
              event_tag: event._tag,
              path,
              duration_ms: duration,
            });
            return Effect.succeed({ ok: false as const, cascades: [] as readonly EventType[] });
          }),
          Effect.flatMap((result) => {
            const duration = Date.now() - startTime;

            log.info("Consumer", "Handler completed", {
              event_type: "handler_complete",
              event_id: eventId,
              event_tag: event._tag,
              path,
              duration_ms: duration,
              cascade_count: result.cascades.length,
            });

            if (result.ok && result.cascades.length > 0) {
              log.info("Consumer", "Cascades generated", {
                event_type: "cascades_generated",
                event_id: eventId,
                event_tag: event._tag,
                path,
                cascade_count: result.cascades.length,
                cascade_tags: result.cascades.map((e) => e._tag),
              });
              return queue.enqueueMany(result.cascades);
            }
            return Effect.void;
          }),
        );
      }),
    ),
  );

let eventCounter = 0;

const logMemorySnapshot = Effect.sync(() => {
  eventCounter++;
  Bun.gc(true);

  if (eventCounter === 100 || eventCounter === 5000) {
    const snapshotPath = `/data/heap-snapshot-${eventCounter}.json`;
    Bun.write(snapshotPath, JSON.stringify(Bun.generateHeapSnapshot()));
    log.info("Consumer", `Heap snapshot saved to ${snapshotPath}`, {
      event_type: "handler_complete",
      events_processed: eventCounter,
    } as any);
  }

  if (eventCounter % 50 === 0) {
    const mem = process.memoryUsage();
    const jsc = heapStats();
    log.info("Consumer", "Memory snapshot", {
      event_type: "handler_complete",
      events_processed: eventCounter,
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      external_mb: Math.round((mem.external ?? 0) / 1024 / 1024),
      jsc_object_count: jsc.objectCount,
      jsc_protected_object_count: jsc.protectedObjectCount,
      jsc_global_object_count: jsc.globalObjectCount,
      jsc_protected_global_object_count: jsc.protectedGlobalObjectCount,
      jsc_object_type_counts: JSON.stringify(
        Object.fromEntries(
          Object.entries(jsc.objectTypeCounts as Record<string, number>)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10),
        ),
      ),
    } as any);
  }
});

export const startConsumer = Effect.flatMap(LoggerService, (logger) =>
  Effect.flatMap(logger.info("Consumer", "Started processing events"), () =>
    Effect.flatMap(EventQueueService, (queue) =>
      queue.take().pipe(
        Effect.flatMap(processEvent),
        Effect.flatMap(() => logMemorySnapshot),
        Effect.forever,
      ),
    ),
  ),
);
