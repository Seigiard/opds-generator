import { Effect } from "effect";
import { heapStats } from "bun:jsc";
import { log } from "../logging/index.ts";
import type { EventType } from "./types.ts";
import { EventQueueService, HandlerRegistry, LoggerService } from "./services.ts";

// Generate unique event ID for tracing
function generateEventId(event: EventType, path: string | undefined): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 7);
  return `${event._tag}:${path ?? "unknown"}:${timestamp}:${random}`;
}

// Extract path from event if available
function getEventPath(event: EventType): string | undefined {
  if ("path" in event && typeof event.path === "string") return event.path;
  if ("parent" in event && "name" in event) return `${event.parent}/${event.name}`;
  if ("parent" in event && typeof event.parent === "string") return event.parent;
  return undefined;
}

// Process a single event using handler from registry
const processEvent = (event: EventType) =>
  Effect.gen(function* () {
    const queue = yield* EventQueueService;
    const registry = yield* HandlerRegistry;
    const logger = yield* LoggerService;

    const path = getEventPath(event);
    const eventId = generateEventId(event, path);
    const startTime = Date.now();

    // Log handler start
    log.info("Consumer", "Handler started", {
      event_type: "handler_start",
      event_id: eventId,
      event_tag: event._tag,
      path,
    });

    // Get handler from registry
    const handler = registry.get(event._tag);
    if (!handler) {
      yield* logger.warn("Consumer", "No handler found", { event_tag: event._tag });
      return;
    }

    // Process event, get cascading events
    const result = yield* handler(event).pipe(
      Effect.map((cascades) => ({ ok: true as const, cascades })),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const duration = Date.now() - startTime;

          yield* logger.error("Consumer", "Handler failed", error, {
            event_type: "handler_error",
            event_id: eventId,
            event_tag: event._tag,
            path,
            duration_ms: duration,
          });

          return { ok: false as const, cascades: [] as readonly EventType[] };
        }),
      ),
    );

    const duration = Date.now() - startTime;

    // Log handler completion
    log.info("Consumer", "Handler completed", {
      event_type: "handler_complete",
      event_id: eventId,
      event_tag: event._tag,
      path,
      duration_ms: duration,
      cascade_count: result.cascades.length,
    });

    // Cascading events go to end of queue (FIFO)
    if (result.ok && result.cascades.length > 0) {
      // Log cascades generated
      log.info("Consumer", "Cascades generated", {
        event_type: "cascades_generated",
        event_id: eventId,
        event_tag: event._tag,
        path,
        cascade_count: result.cascades.length,
        cascade_tags: result.cascades.map((e) => e._tag),
      });

      yield* queue.enqueueMany(result.cascades);
    }
  });

let eventCounter = 0;

export const startConsumer = Effect.gen(function* () {
  const queue = yield* EventQueueService;
  const logger = yield* LoggerService;

  yield* logger.info("Consumer", "Started processing events");

  while (true) {
    const event = yield* queue.take();
    yield* processEvent(event);
    Bun.gc(true);
    eventCounter++;

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
  }
});
