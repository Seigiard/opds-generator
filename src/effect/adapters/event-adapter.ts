import { Effect } from "effect";
import { dirname, join } from "node:path";
import { BOOK_EXTENSIONS } from "../../types.ts";
import type { RawWatcherEvent, EventType } from "../types.ts";
import { DeduplicationService } from "../services.ts";
import type { SyncPlan } from "../../scanner.ts";

// Classify raw inotifywait event into typed EventType
function classifyRawEvent(event: RawWatcherEvent): EventType {
  if (event.watcher === "data") {
    if (event.name === "entry.xml") {
      return { _tag: "EntryXmlChanged", parent: event.parent };
    }
    if (event.name === "_entry.xml") {
      return { _tag: "FolderEntryXmlChanged", parent: event.parent };
    }
    return { _tag: "Ignored" };
  }

  const isDir = event.events.includes("ISDIR");
  const isDelete = event.events.includes("DELETE") || event.events.includes("MOVED_FROM");
  const isCreate = event.events.includes("CREATE") || event.events.includes("CLOSE_WRITE") || event.events.includes("MOVED_TO");

  if (isDir) {
    if (isDelete) {
      return { _tag: "FolderDeleted", parent: event.parent, name: event.name };
    }
    if (isCreate) {
      return { _tag: "FolderCreated", parent: event.parent, name: event.name };
    }
    return { _tag: "Ignored" };
  }

  const ext = event.name.split(".").pop()?.toLowerCase() ?? "";
  if (!BOOK_EXTENSIONS.includes(ext)) {
    return { _tag: "Ignored" };
  }

  if (isDelete) {
    return { _tag: "BookDeleted", parent: event.parent, name: event.name };
  }
  if (isCreate) {
    return { _tag: "BookCreated", parent: event.parent, name: event.name };
  }

  return { _tag: "Ignored" };
}

// Generate deduplication key for an event
function getEventKey(event: EventType): string {
  switch (event._tag) {
    case "BookCreated":
    case "BookDeleted":
    case "FolderCreated":
    case "FolderDeleted":
      return `${event._tag}:${event.parent}:${event.name}`;
    case "EntryXmlChanged":
    case "FolderEntryXmlChanged":
      return `${event._tag}:${event.parent}`;
    case "FolderMetaSyncRequested":
      return `${event._tag}:${event.path}`;
    case "Ignored":
      return "Ignored";
  }
}

// Adapt raw watcher event to typed EventType with deduplication
export const adaptWatcherEvent = (raw: RawWatcherEvent) =>
  Effect.gen(function* () {
    const dedup = yield* DeduplicationService;

    const eventType = classifyRawEvent(raw);
    if (eventType._tag === "Ignored") return null;

    const key = getEventKey(eventType);
    const shouldProcess = yield* dedup.shouldProcess(key);

    return shouldProcess ? eventType : null;
  });

// Parse path into parent and name for events
function parsePath(filesPath: string, relativePath: string): { parent: string; name: string } {
  const fullPath = join(filesPath, relativePath);
  const parent = dirname(fullPath) + "/";
  const name = relativePath.split("/").pop() ?? "";
  return { parent, name };
}

// Adapt sync plan to typed events (no deduplication for initialSync)
export function adaptSyncPlan(plan: SyncPlan, filesPath: string): EventType[] {
  const events: EventType[] = [];

  for (const path of plan.toDelete) {
    const { parent, name } = parsePath(filesPath, path);
    events.push({ _tag: "BookDeleted", parent, name });
  }

  for (const folder of plan.folders) {
    const { parent, name } = parsePath(filesPath, folder.path);
    events.push({ _tag: "FolderCreated", parent, name });
  }

  for (const file of plan.toProcess) {
    const { parent, name } = parsePath(filesPath, file.relativePath);
    events.push({ _tag: "BookCreated", parent, name });
  }

  return events;
}
