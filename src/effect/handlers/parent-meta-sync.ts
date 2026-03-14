import { Effect } from "effect";
import { dirname, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { log } from "../../logging/index.ts";

export const parentMetaSync = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> => {
  if (event._tag !== "EntryXmlChanged") return Effect.succeed([]);

  return Effect.flatMap(ConfigService, (config) => {
    const folderDataDir = event.parent;
    const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
    const parentDataDir = dirname(normalizedDir);
    const parentRelativePath = relative(config.dataPath, parentDataDir);

    if (parentDataDir === config.dataPath || parentRelativePath === ".") {
      log.info("ParentMetaSync", "Triggering root sync", { path: "/" });
      return Effect.succeed([{ _tag: "FolderMetaSyncRequested", path: config.dataPath }] as const);
    }

    log.info("ParentMetaSync", "Triggering parent sync", { path: parentRelativePath });
    return Effect.succeed([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const);
  });
};
