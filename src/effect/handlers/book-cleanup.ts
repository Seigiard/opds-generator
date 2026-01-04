import { Effect } from "effect";
import { dirname, join, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";

export const bookCleanup = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
  Effect.gen(function* () {
    if (event._tag !== "BookDeleted") return [];
    const { parent, name } = event;
    const config = yield* ConfigService;
    const logger = yield* LoggerService;
    const fs = yield* FileSystemService;

    const filePath = join(parent, name);
    const relativePath = relative(config.filesPath, filePath);
    const bookDataDir = join(config.dataPath, relativePath);

    yield* logger.info("BookCleanup", `Removing: ${relativePath}`);

    yield* fs.rm(bookDataDir, { recursive: true }).pipe(
      Effect.catchAll((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return logger.debug("BookCleanup", `Already removed: ${relativePath}`);
        }
        return Effect.fail(error);
      }),
    );

    yield* logger.info("BookCleanup", `Done: ${relativePath}`);

    // Cascade: regenerate parent folder's feed.xml
    const parentDataDir = dirname(bookDataDir);
    return [{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const;
  });
