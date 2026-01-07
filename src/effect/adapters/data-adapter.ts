import { Effect, Match } from "effect";
import type { RawDataEvent, EventType } from "../types.ts";
import { DeduplicationService, EventLogService } from "../services.ts";
import { ENTRY_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";

// Classify data watcher event using Effect Match
function classifyDataEvent(raw: RawDataEvent): EventType {
  return Match.value(raw.name).pipe(
    Match.when(ENTRY_FILE, () => ({
      _tag: "EntryXmlChanged" as const,
      parent: raw.parent,
    })),

    Match.when(FOLDER_ENTRY_FILE, () => ({
      _tag: "FolderEntryXmlChanged" as const,
      parent: raw.parent,
    })),

    Match.orElse(() => ({ _tag: "Ignored" as const })),
  );
}

// Generate deduplication key for an event
function getEventKey(event: EventType): string {
  switch (event._tag) {
    case "EntryXmlChanged":
    case "FolderEntryXmlChanged":
      return `${event._tag}:${event.parent}`;
    case "Ignored":
      return "Ignored";
    default:
      return `${event._tag}:unknown`;
  }
}

// Adapt data watcher event to typed EventType with deduplication
export const adaptDataEvent = (raw: RawDataEvent) =>
  Effect.gen(function* () {
    const dedup = yield* DeduplicationService;
    const eventLog = yield* EventLogService;

    const eventType = classifyDataEvent(raw);
    const path = `${raw.parent}/${raw.name}`;
    const eventId = `raw:data:${path}:${Date.now()}`;

    // Log event received (all events including ignored)
    yield* eventLog.log({
      timestamp: new Date().toISOString(),
      type: "event_received",
      event_id: eventId,
      event_tag: eventType._tag,
      path,
    });

    if (eventType._tag === "Ignored") {
      // Log ignored event
      yield* eventLog.log({
        timestamp: new Date().toISOString(),
        type: "event_ignored",
        event_id: eventId,
        event_tag: "Ignored",
        path,
      });
      return null;
    }

    const key = getEventKey(eventType);
    const shouldProcess = yield* dedup.shouldProcess(key);

    if (!shouldProcess) {
      // Log deduplicated event
      yield* eventLog.log({
        timestamp: new Date().toISOString(),
        type: "event_deduplicated",
        event_id: eventId,
        event_tag: eventType._tag,
        path,
      });
    }

    return shouldProcess ? eventType : null;
  });
