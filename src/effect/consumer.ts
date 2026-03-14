import { heapStats } from "bun:jsc";
import { log } from "../logging/index.ts";
import type { AppContext } from "../context.ts";
import type { EventType } from "./types.ts";

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

let eventCounter = 0;

function logMemorySnapshot(): void {
  eventCounter++;
  Bun.gc(true);

  if (eventCounter === 100 || eventCounter === 3000) {
    const snapshotPath = `/data/heap-snapshot-${eventCounter}.json`;
    void Bun.write(snapshotPath, JSON.stringify(Bun.generateHeapSnapshot()));
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
    } as any);
  }
}

export async function startConsumer(ctx: AppContext, signal: AbortSignal): Promise<void> {
  ctx.logger.info("Consumer", "Started processing events");

  while (!signal.aborted) {
    let event: EventType;
    try {
      event = await ctx.queue.take(signal);
    } catch {
      if (signal.aborted) break;
      throw new Error("Queue take failed unexpectedly");
    }

    const path = getEventPath(event);
    const eventId = generateEventId(event, path);
    const startTime = Date.now();

    log.info("Consumer", "Handler started", {
      event_type: "handler_start",
      event_id: eventId,
      event_tag: event._tag,
      path,
    });

    const handler = ctx.handlers.get(event._tag);
    if (!handler) {
      ctx.logger.warn("Consumer", "No handler found", { event_tag: event._tag });
      logMemorySnapshot();
      continue;
    }

    const deps = { config: ctx.config, logger: ctx.logger, fs: ctx.fs };

    try {
      const result = await handler(event, deps);
      const duration = Date.now() - startTime;

      if (result.isOk()) {
        log.info("Consumer", "Handler completed", {
          event_type: "handler_complete",
          event_id: eventId,
          event_tag: event._tag,
          path,
          duration_ms: duration,
          cascade_count: result.value.length,
        });

        if (result.value.length > 0) {
          log.info("Consumer", "Cascades generated", {
            event_type: "cascades_generated",
            event_id: eventId,
            event_tag: event._tag,
            path,
            cascade_count: result.value.length,
            cascade_tags: result.value.map((e) => e._tag),
          });
          ctx.queue.enqueueMany(result.value);
        }
      } else {
        log.error("Consumer", "Handler failed", result.error, {
          event_type: "handler_error",
          event_id: eventId,
          event_tag: event._tag,
          path,
          duration_ms: duration,
        });
      }
    } catch (err) {
      ctx.logger.error("Consumer", "Unexpected handler throw", err, { event_tag: event._tag });
    }

    logMemorySnapshot();

    if (eventCounter % 100 === 0) Bun.gc(true);
  }
}
function heapStats() {
  throw new Error("Function not implemented.");
}
