import { Effect } from "effect";
import { dirname, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";

export const parentMetaSync = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
  Effect.gen(function* () {
    if (event._tag !== "EntryXmlChanged") return [];
    const folderDataDir = event.parent;

    const config = yield* ConfigService;
    const logger = yield* LoggerService;

    const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
    const parentDataDir = dirname(normalizedDir);
    const parentRelativePath = relative(config.dataPath, parentDataDir);

    if (parentDataDir === config.dataPath || parentRelativePath === ".") {
      yield* logger.info("ParentMetaSync", "Triggering root sync", { path: "/" });
      return [{ _tag: "FolderMetaSyncRequested", path: config.dataPath }] as const;
    }

    yield* logger.info("ParentMetaSync", "Triggering parent sync", { path: parentRelativePath });
    return [{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const;
  });
