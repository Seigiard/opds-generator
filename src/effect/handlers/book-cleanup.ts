import { Effect } from "effect";
import { dirname, join, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { log } from "../../logging/index.ts";

export const bookCleanup = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> => {
  if (event._tag !== "BookDeleted") return Effect.succeed([]);

  return Effect.flatMap(ConfigService, (config) =>
    Effect.flatMap(FileSystemService, (fs) => {
      const { parent, name } = event;
      const filePath = join(parent, name);
      const relativePath = relative(config.filesPath, filePath);
      const bookDataDir = join(config.dataPath, relativePath);

      log.info("BookCleanup", "Removing", { path: relativePath });

      return fs.rm(bookDataDir, { recursive: true }).pipe(
        Effect.catchAll((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            log.debug("BookCleanup", "Already removed", { path: relativePath });
            return Effect.void;
          }
          return Effect.fail(error);
        }),
        Effect.map(() => {
          log.info("BookCleanup", "Done", { path: relativePath });
          const parentDataDir = dirname(bookDataDir);
          return [{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const;
        }),
      );
    }),
  );
};
