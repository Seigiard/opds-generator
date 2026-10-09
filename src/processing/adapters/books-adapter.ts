import { join } from "node:path";
import { log } from "../../logging/index.ts";
import { BOOK_EXTENSIONS } from "../../types.ts";
import type { RawBooksEvent, EventType } from "../types.ts";

function parseEvents(events: string) {
  const parts = events.split(",");
  const isDir = parts.includes("ISDIR");
  const event = parts.find((p) => p !== "ISDIR") ?? "";

  return { event, isDir };
}

function isValidBookExtension(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";

  return BOOK_EXTENSIONS.includes(ext);
}

function classifyBooksEvent(raw: RawBooksEvent): EventType {
  const { event, isDir } = parseEvents(raw.events);
  const { parent, name } = raw;

  if (name.startsWith(".")) return { _tag: "Ignored" };

  if (event === "CREATE" && isDir) return { _tag: "FolderCreated", parent, name };

  if (event === "CREATE" && !isDir) return { _tag: "Ignored" };

  if (event === "CLOSE_WRITE") return isValidBookExtension(name) ? { _tag: "BookCreated", parent, name } : { _tag: "Ignored" };

  if (event === "DELETE" && isDir) return { _tag: "FolderDeleted", parent, name };

  if (event === "DELETE" && !isDir) return isValidBookExtension(name) ? { _tag: "BookDeleted", parent, name } : { _tag: "Ignored" };

  if (event === "MOVED_FROM" && isDir) return { _tag: "FolderDeleted", parent, name };

  if (event === "MOVED_FROM" && !isDir) return isValidBookExtension(name) ? { _tag: "BookDeleted", parent, name } : { _tag: "Ignored" };

  if (event === "MOVED_TO" && isDir) return { _tag: "FolderCreated", parent, name };

  if (event === "MOVED_TO" && !isDir) return isValidBookExtension(name) ? { _tag: "BookCreated", parent, name } : { _tag: "Ignored" };

  return { _tag: "Ignored" };
}

export function adaptBooksEvent(raw: RawBooksEvent): EventType | null {
  const eventType = classifyBooksEvent(raw);

  if (eventType._tag === "Ignored") {
    const path = join(raw.parent, raw.name);

    log.debug("Adapter", "Event ignored", {
      event_type: "event_ignored",
      event_id: `raw:books:${path}:${Date.now()}`,
      event_tag: "Ignored",
      path,
    });

    return null;
  }

  // Repeated notices are not dropped here: the engine coalesces hints, so a replacement during active work stays actionable.
  return eventType;
}
