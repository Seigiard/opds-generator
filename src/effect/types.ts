export interface RawBooksEvent {
  parent: string;
  name: string;
  events: string;
}

export interface RawDataEvent {
  parent: string;
  name: string;
  events: string;
}

export function isRawBooksEvent(u: unknown): u is RawBooksEvent {
  return (
    typeof u === "object" &&
    u !== null &&
    "parent" in u &&
    typeof (u as Record<string, unknown>).parent === "string" &&
    "name" in u &&
    typeof (u as Record<string, unknown>).name === "string" &&
    "events" in u &&
    typeof (u as Record<string, unknown>).events === "string"
  );
}

export function isRawDataEvent(u: unknown): u is RawDataEvent {
  return (
    typeof u === "object" &&
    u !== null &&
    "parent" in u &&
    typeof (u as Record<string, unknown>).parent === "string" &&
    "name" in u &&
    typeof (u as Record<string, unknown>).name === "string" &&
    "events" in u &&
    typeof (u as Record<string, unknown>).events === "string"
  );
}

export type EventType =
  | { _tag: "BookCreated"; parent: string; name: string }
  | { _tag: "BookDeleted"; parent: string; name: string }
  | { _tag: "FolderCreated"; parent: string; name: string }
  | { _tag: "FolderDeleted"; parent: string; name: string }
  | { _tag: "EntryXmlChanged"; parent: string }
  | { _tag: "FolderEntryXmlChanged"; parent: string }
  | { _tag: "FolderMetaSyncRequested"; path: string }
  | { _tag: "Ignored" };
