import { Effect } from "effect";
import { dirname, join, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";

export const folderCleanup = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
  Effect.gen(function* () {
    if (event._tag !== "FolderDeleted") return [];
    const { parent, name } = event;
    const config = yield* ConfigService;
    const logger = yield* LoggerService;
    const fs = yield* FileSystemService;

    const folderPath = join(parent, name);
    const relativePath = relative(config.filesPath, folderPath);
    const folderDataDir = join(config.dataPath, relativePath);

    yield* logger.info("FolderCleanup", "Removing", { path: relativePath });

    yield* fs.rm(folderDataDir, { recursive: true }).pipe(
      Effect.catchAll((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return logger.debug("FolderCleanup", "Already removed", { path: relativePath });
        }
        return Effect.fail(error);
      }),
    );

    yield* logger.info("FolderCleanup", "Done", { path: relativePath });

    // Cascade: regenerate parent folder's feed.xml (unless at root)
    const parentDataDir = dirname(folderDataDir);
    if (parentDataDir !== config.dataPath && parentDataDir !== ".") {
      return [{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const;
    }
    return [];
  });
