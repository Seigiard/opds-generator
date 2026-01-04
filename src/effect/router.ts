import { Effect } from "effect";
import type { EventType } from "./events.ts";
import { bookSync } from "./handlers/book-sync.ts";
import { bookCleanup } from "./handlers/book-cleanup.ts";
import { folderSync } from "./handlers/folder-sync.ts";
import { folderCleanup } from "./handlers/folder-cleanup.ts";
import { folderMetaSync } from "./handlers/folder-meta-sync.ts";
import { parentMetaSync } from "./handlers/parent-meta-sync.ts";
import { ConfigService, LoggerService, FileSystemService } from "./services.ts";

export const handleEvent = (
	event: EventType,
): Effect.Effect<void, Error, ConfigService | LoggerService | FileSystemService> => {
	switch (event._tag) {
		case "BookCreated":
			return bookSync(event.parent, event.name);

		case "BookDeleted":
			return bookCleanup(event.parent, event.name);

		case "FolderCreated":
			return folderSync(event.parent, event.name);

		case "FolderDeleted":
			return folderCleanup(event.parent, event.name);

		case "EntryXmlChanged":
			// entry.xml changed → update parent folder's feed.xml
			return parentMetaSync(event.parent);

		case "FolderEntryXmlChanged":
			// _entry.xml changed → update this folder's feed.xml + parent's feed.xml
			return Effect.all([folderMetaSync(event.parent), parentMetaSync(event.parent)], {
				concurrency: 1,
			}).pipe(Effect.asVoid);

		case "Ignored":
			return Effect.void;
	}
};
