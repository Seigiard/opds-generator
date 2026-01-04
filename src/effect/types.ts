import { Schema } from "@effect/schema";

// Raw event from inotifywait via HTTP (validation schema)
export const RawWatcherEvent = Schema.Struct({
  watcher: Schema.Literal("books", "data"),
  parent: Schema.String,
  name: Schema.String,
  events: Schema.String,
});

export type RawWatcherEvent = typeof RawWatcherEvent.Type;

// Classified event types for handlers
export type EventType =
  | { _tag: "BookCreated"; parent: string; name: string }
  | { _tag: "BookDeleted"; parent: string; name: string }
  | { _tag: "FolderCreated"; parent: string; name: string }
  | { _tag: "FolderDeleted"; parent: string; name: string }
  | { _tag: "EntryXmlChanged"; parent: string }
  | { _tag: "FolderEntryXmlChanged"; parent: string }
  | { _tag: "FolderMetaSyncRequested"; path: string }
  | { _tag: "Ignored" };
