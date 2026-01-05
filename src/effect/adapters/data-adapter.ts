import { Effect, Match } from "effect";
import type { RawDataEvent, EventType } from "../types.ts";
import { DeduplicationService } from "../services.ts";
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

    const eventType = classifyDataEvent(raw);
    if (eventType._tag === "Ignored") return null;

    const key = getEventKey(eventType);
    const shouldProcess = yield* dedup.shouldProcess(key);

    return shouldProcess ? eventType : null;
  });
