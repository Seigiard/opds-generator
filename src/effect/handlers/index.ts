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

  registry.registerAsync("BookCreated", bookSync);
  registry.registerAsync("BookDeleted", bookCleanup);
  registry.registerAsync("FolderCreated", folderSync);
  registry.registerAsync("FolderDeleted", folderCleanup);
  registry.registerAsync("EntryXmlChanged", parentMetaSync);
  registry.registerAsync("FolderEntryXmlChanged", folderEntryXmlChanged);
  registry.registerAsync("FolderMetaSyncRequested", folderMetaSync);
});
