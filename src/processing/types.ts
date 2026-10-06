import * as v from "valibot";

const rawEventSchema = v.object({ parent: v.string(), name: v.string(), events: v.string() });

export type RawBooksEvent = v.InferOutput<typeof rawEventSchema>;

export type RawDataEvent = v.InferOutput<typeof rawEventSchema>;

export function isRawBooksEvent(u: unknown): u is RawBooksEvent {
  return v.is(rawEventSchema, u);
}

export function isRawDataEvent(u: unknown): u is RawDataEvent {
  return v.is(rawEventSchema, u);
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
