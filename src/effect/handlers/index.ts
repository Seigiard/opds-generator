import { Effect } from "effect";
import { HandlerRegistry } from "../services.ts";
import { bookSync } from "./book-sync.ts";
import { bookCleanup } from "./book-cleanup.ts";
import { folderSync } from "./folder-sync.ts";
import { folderCleanup } from "./folder-cleanup.ts";
import { folderMetaSync } from "./folder-meta-sync.ts";
import { parentMetaSync } from "./parent-meta-sync.ts";
import { folderEntryXmlChanged } from "./folder-entry-xml-changed.ts";

export const registerHandlers = Effect.gen(function* () {
	const registry = yield* HandlerRegistry;

	registry.register("BookCreated", bookSync);
	registry.register("BookDeleted", bookCleanup);
	registry.register("FolderCreated", folderSync);
	registry.register("FolderDeleted", folderCleanup);
	registry.register("EntryXmlChanged", parentMetaSync);
	registry.register("FolderEntryXmlChanged", folderEntryXmlChanged);
	registry.register("FolderMetaSyncRequested", folderMetaSync);
});

export { bookSync } from "./book-sync.ts";
export { bookCleanup } from "./book-cleanup.ts";
export { folderSync } from "./folder-sync.ts";
export { folderCleanup } from "./folder-cleanup.ts";
export { folderMetaSync } from "./folder-meta-sync.ts";
export { parentMetaSync } from "./parent-meta-sync.ts";
export { folderEntryXmlChanged } from "./folder-entry-xml-changed.ts";
