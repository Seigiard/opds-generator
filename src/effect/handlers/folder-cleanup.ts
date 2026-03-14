import { Effect } from "effect";
import { dirname, join, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { log } from "../../logging/index.ts";

export const folderCleanup = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> => {
  if (event._tag !== "FolderDeleted") return Effect.succeed([]);

  return Effect.flatMap(ConfigService, (config) =>
    Effect.flatMap(FileSystemService, (fs) => {
      const { parent, name } = event;
      const folderPath = join(parent, name);
      const relativePath = relative(config.filesPath, folderPath);
      const folderDataDir = join(config.dataPath, relativePath);

      log.info("FolderCleanup", "Removing", { path: relativePath });

      return fs.rm(folderDataDir, { recursive: true }).pipe(
        Effect.catchAll((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            log.debug("FolderCleanup", "Already removed", { path: relativePath });
            return Effect.void;
          }
          return Effect.fail(error);
        }),
        Effect.map(() => {
          log.info("FolderCleanup", "Done", { path: relativePath });
          const parentDataDir = dirname(folderDataDir);
          if (parentDataDir !== config.dataPath && parentDataDir !== ".") {
            return [{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const;
          }
          return [] as const;
        }),
      );
    }),
  );
};
