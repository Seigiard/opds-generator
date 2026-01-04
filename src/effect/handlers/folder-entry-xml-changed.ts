import { Effect } from "effect";
import { dirname, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";

// When _entry.xml changes, trigger both folder-meta-sync for this folder AND parent
export const folderEntryXmlChanged = (
	event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
	Effect.gen(function* () {
		if (event._tag !== "FolderEntryXmlChanged") return [];
		const folderDataDir = event.parent;

		const config = yield* ConfigService;
		const logger = yield* LoggerService;

		const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
		const parentDataDir = dirname(normalizedDir);
		const parentRelativePath = relative(config.dataPath, parentDataDir);

		yield* logger.info("FolderEntryXmlChanged", `Triggering folder-meta-sync for current and parent`);

		// Emit events for both current folder and parent
		const events: EventType[] = [{ _tag: "FolderMetaSyncRequested", path: normalizedDir }];

		if (parentDataDir === config.dataPath || parentRelativePath === ".") {
			events.push({ _tag: "FolderMetaSyncRequested", path: config.dataPath });
		} else {
			events.push({ _tag: "FolderMetaSyncRequested", path: parentDataDir });
		}

		return events;
	});
