import { Effect, Match } from "effect";
import { log } from "../../logging/index.ts";
import { BOOK_EXTENSIONS } from "../../types.ts";
import type { RawBooksEvent, EventType } from "../types.ts";
import { DeduplicationService } from "../services.ts";

// Parse inotify events string into components
function parseEvents(events: string): { event: string; isDir: boolean } {
  const parts = events.split(",");
  const isDir = parts.includes("ISDIR");
  const event = parts.find((p) => p !== "ISDIR") ?? "";
  return { event, isDir };
}

// Check if file has valid book extension
function isValidBookExtension(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return BOOK_EXTENSIONS.includes(ext);
}

// Classify books watcher event using Effect Match
function classifyBooksEvent(raw: RawBooksEvent): EventType {
  const { event, isDir } = parseEvents(raw.events);

  return Match.value({ event, isDir, name: raw.name, parent: raw.parent }).pipe(
    // CREATE + ISDIR → FolderCreated
    Match.when({ event: "CREATE", isDir: true }, ({ parent, name }) => ({
      _tag: "FolderCreated" as const,
      parent,
      name,
    })),

    // CREATE without ISDIR → Ignored (wait for CLOSE_WRITE)
    Match.when({ event: "CREATE", isDir: false }, () => ({
      _tag: "Ignored" as const,
    })),

    // CLOSE_WRITE → BookCreated (if valid extension)
    Match.when({ event: "CLOSE_WRITE" }, ({ parent, name }) =>
      isValidBookExtension(name) ? { _tag: "BookCreated" as const, parent, name } : { _tag: "Ignored" as const },
    ),

    // DELETE + ISDIR → FolderDeleted
    Match.when({ event: "DELETE", isDir: true }, ({ parent, name }) => ({
      _tag: "FolderDeleted" as const,
      parent,
      name,
    })),

    // DELETE without ISDIR → BookDeleted (if valid extension)
    Match.when({ event: "DELETE", isDir: false }, ({ parent, name }) =>
      isValidBookExtension(name) ? { _tag: "BookDeleted" as const, parent, name } : { _tag: "Ignored" as const },
    ),

    // MOVED_FROM + ISDIR → FolderDeleted
    Match.when({ event: "MOVED_FROM", isDir: true }, ({ parent, name }) => ({
      _tag: "FolderDeleted" as const,
      parent,
      name,
    })),

    // MOVED_FROM without ISDIR → BookDeleted (if valid extension)
    Match.when({ event: "MOVED_FROM", isDir: false }, ({ parent, name }) =>
      isValidBookExtension(name) ? { _tag: "BookDeleted" as const, parent, name } : { _tag: "Ignored" as const },
    ),

    // MOVED_TO + ISDIR → FolderCreated
    Match.when({ event: "MOVED_TO", isDir: true }, ({ parent, name }) => ({
      _tag: "FolderCreated" as const,
      parent,
      name,
    })),

    // MOVED_TO without ISDIR → BookCreated (if valid extension)
    Match.when({ event: "MOVED_TO", isDir: false }, ({ parent, name }) =>
      isValidBookExtension(name) ? { _tag: "BookCreated" as const, parent, name } : { _tag: "Ignored" as const },
    ),

    // Unknown events → Ignored silently
    Match.orElse(() => ({ _tag: "Ignored" as const })),
  );
}

// Generate deduplication key for an event
function getEventKey(event: EventType): string {
  switch (event._tag) {
    case "BookCreated":
    case "BookDeleted":
    case "FolderCreated":
    case "FolderDeleted":
      return `${event._tag}:${event.parent}:${event.name}`;
    case "Ignored":
      return "Ignored";
    default:
      return `${event._tag}:unknown`;
  }
}

// Adapt books watcher event to typed EventType with deduplication
export const adaptBooksEvent = (raw: RawBooksEvent) =>
  Effect.gen(function* () {
    const dedup = yield* DeduplicationService;

    const eventType = classifyBooksEvent(raw);
    const path = `${raw.parent}/${raw.name}`;
    const eventId = `raw:books:${path}:${Date.now()}`;

    if (eventType._tag === "Ignored") {
      // Log ignored event
      log.debug("Adapter", "Event ignored", {
        event_type: "event_ignored",
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
      log.debug("Adapter", "Event deduplicated", {
        event_type: "event_deduplicated",
        event_id: eventId,
        event_tag: eventType._tag,
        path,
      });
    }

    return shouldProcess ? eventType : null;
  });
