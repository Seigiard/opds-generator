import { Schema } from "@effect/schema";
import { BOOK_EXTENSIONS } from "../types.ts";

// Raw event from inotifywait via HTTP
export const FileEvent = Schema.Struct({
	watcher: Schema.Literal("books", "data"),
	parent: Schema.String,
	name: Schema.String,
	events: Schema.String,
});

export type FileEvent = typeof FileEvent.Type;

// Classified event types for handlers
export type EventType =
	| { _tag: "BookCreated"; parent: string; name: string }
	| { _tag: "BookDeleted"; parent: string; name: string }
	| { _tag: "FolderCreated"; parent: string; name: string }
	| { _tag: "FolderDeleted"; parent: string; name: string }
	| { _tag: "EntryXmlChanged"; parent: string }
	| { _tag: "FolderEntryXmlChanged"; parent: string }
	| { _tag: "Ignored" };

export function classifyEvent(event: FileEvent): EventType {
	if (event.watcher === "data") {
		// Data watcher: entry.xml or _entry.xml changes
		if (event.name === "entry.xml") {
			return { _tag: "EntryXmlChanged", parent: event.parent };
		}
		if (event.name === "_entry.xml") {
			return { _tag: "FolderEntryXmlChanged", parent: event.parent };
		}
		return { _tag: "Ignored" };
	}

	// Books watcher
	const isDir = event.events.includes("ISDIR");
	const isDelete = event.events.includes("DELETE") || event.events.includes("MOVED_FROM");
	const isCreate =
		event.events.includes("CREATE") ||
		event.events.includes("CLOSE_WRITE") ||
		event.events.includes("MOVED_TO");

	if (isDir) {
		if (isDelete) {
			return { _tag: "FolderDeleted", parent: event.parent, name: event.name };
		}
		if (isCreate) {
			return { _tag: "FolderCreated", parent: event.parent, name: event.name };
		}
		return { _tag: "Ignored" };
	}

	// Check if it's a book file
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
