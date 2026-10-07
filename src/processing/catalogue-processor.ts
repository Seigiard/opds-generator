import { heapStats } from "bun:jsc";
import { join } from "node:path";
import type { Result } from "neverthrow";
import { log } from "../logging/index.ts";
import { SimpleQueue } from "../queue.ts";
import type { HandlerDeps } from "../context.ts";
import type { EventType } from "./types.ts";

export type Handler = (event: EventType, deps: HandlerDeps) => Promise<Result<readonly EventType[], Error>>;

export type Handlers = Readonly<Partial<Record<EventType["_tag"], Handler>>>;

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

interface CatalogueProcessorOptions {
  readonly deps: Omit<HandlerDeps, "signal">;
  readonly handlers: Handlers;
}

function generateEventId(event: EventType, path: string | undefined): string {
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

function logMemorySnapshot(): void {
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

export function createCatalogueProcessor({ deps, handlers }: CatalogueProcessorOptions): CatalogueProcessor {
  const queue = new SimpleQueue<EventType>((event) =>
    event._tag === "FolderMetaSyncRequested" ? `${event._tag}:${event.path}` : undefined,
  );

  const busyListeners = new Set<() => void>();
  const emptyListeners = new Set<() => void>();

  // Counted here, not read from the queue: work handed straight to a waiting consumer never sits in the buffer.
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
      if (!queue.enqueue(item)) continue;

      pending++;

      if (!busy) {
        busy = true;
        emit(busyListeners);
      }
    }
  };

  const settle = (): void => {
    active = null;

    if (pending === 0 && busy) {
      busy = false;
      emit(emptyListeners);
    }
  };

  const runWork = async (event: EventType, signal: AbortSignal): Promise<"aborted" | "done"> => {
    const path = getEventPath(event);
    const eventId = generateEventId(event, path);
    const startTime = Date.now();

    log.info("Consumer", "Handler started", {
      event_type: "handler_start",
      event_id: eventId,
      event_tag: event._tag,
      path,
    });

    const handler = handlers[event._tag];

    if (!handler) {
      deps.logger.warn("Consumer", "No handler found", { event_tag: event._tag });

      return "done";
    }

    try {
      const result = await handler(event, { ...deps, signal });

      if (signal.aborted) return "aborted";
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
          submit(result.value);
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
      if (signal.aborted) return "aborted";
      deps.logger.error("Consumer", "Unexpected handler throw", err, { event_tag: event._tag });
    }

    return "done";
  };

  const start = async (signal: AbortSignal): Promise<void> => {
    deps.logger.info("Consumer", "Started processing events");
    signal.addEventListener("abort", () => (shutdown = true), { once: true });
    shutdown = signal.aborted;

    while (!signal.aborted) {
      let event: EventType;

      try {
        event = await queue.take(signal);
      } catch {
        if (signal.aborted) break;
        throw new Error("Queue take failed unexpectedly");
      }

      pending--;
      active = { kind: event._tag, path: getEventPath(event) ?? null };

      if ((await runWork(event, signal)) === "aborted") {
        active = null;
        break;
      }

      // Cascades are already pending here, so the active slot clears into a non-empty state.
      settle();
      logMemorySnapshot();
    }
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
