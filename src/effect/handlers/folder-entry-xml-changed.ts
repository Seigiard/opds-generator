import { Effect } from "effect";
import { dirname, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { log } from "../../logging/index.ts";

export const folderEntryXmlChanged = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> => {
  if (event._tag !== "FolderEntryXmlChanged") return Effect.succeed([]);

  return Effect.flatMap(ConfigService, (config) => {
    const folderDataDir = event.parent;
    const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
    const parentDataDir = dirname(normalizedDir);
    const parentRelativePath = relative(config.dataPath, parentDataDir);

    log.info("FolderEntryXmlChanged", "Triggering folder-meta-sync for current and parent");

    const events: EventType[] = [{ _tag: "FolderMetaSyncRequested", path: normalizedDir }];

    if (parentDataDir === config.dataPath || parentRelativePath === ".") {
      events.push({ _tag: "FolderMetaSyncRequested", path: config.dataPath });
    } else {
      events.push({ _tag: "FolderMetaSyncRequested", path: parentDataDir });
    }

    return Effect.succeed(events);
  });
};
