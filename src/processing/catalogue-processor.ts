import { heapStats } from "bun:jsc";
import { join } from "node:path";
import { log } from "../logging/index.ts";
import type { EventType } from "./types.ts";

export interface ProcessorStatus {
  readonly pending: number;
  readonly active: { readonly kind: EventType["_tag"]; readonly path: string | null } | null;
}

export interface CatalogueProcessor {
  /** Accepts catalogue work. A folder refresh that is already pending is coalesced and adds nothing. */
  submit(work: EventType | readonly EventType[]): void;
  /** Runs the consumer loop until the signal aborts. Abort cancels the active handler and drops pending work and its cascades. */
  start(signal: AbortSignal): Promise<void>;
  status(): ProcessorStatus;
  /** Fires once when idle work arrives. Silent after shutdown. Returns an unsubscribe function. */
  onBusy(listener: () => void): () => void;
  /** Fires once when the last pending and active work, cascades included, has finished. Silent after shutdown. */
  onEmpty(listener: () => void): () => void;
}

export function generateEventId(event: EventType, path: string | undefined): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 7);

  return `${event._tag}:${path ?? "unknown"}:${timestamp}:${random}`;
}

export function getEventPath(event: EventType): string | undefined {
  if ("path" in event) return event.path;

  if ("parent" in event && "name" in event) return join(event.parent, event.name);

  return undefined;
}

let eventCounter = 0;

export function logMemorySnapshot(): void {
  eventCounter++;

  if (eventCounter % 50 === 0) {
    const mem = process.memoryUsage();
    const jsc = heapStats();
    log.debug("Consumer", "Memory snapshot", {
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
    });
  }
}
