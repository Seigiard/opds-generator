import { Data, Effect, Predicate } from "effect";
import { dirname, join, relative } from "node:path";
import { EffectFileSystem, type FileSystemError } from "../../effect-file-system.ts";
import { CatalogueDeps, CatalogueEvent } from "../effect-handler.ts";
import type { EventType } from "../types.ts";

interface FailureProps {
  readonly path: string;
  readonly cause: FileSystemError;
  readonly message: string;
}

class BookCleanupSourceProbeFailed extends Data.TaggedError("BookCleanupSourceProbeFailed")<FailureProps> {}

class BookCleanupRemoveFailed extends Data.TaggedError("BookCleanupRemoveFailed")<FailureProps> {}

/** Issue #36: Effect port of `bookCleanup`. Only a missing data dir is a recovered removal error. */
export const bookCleanupEffect = Effect.fn("bookCleanup")(function* (event: EventType) {
  if (!Predicate.isTagged(event, "BookDeleted")) return [];

  const { config, logger } = yield* CatalogueDeps;
  const fs = yield* EffectFileSystem;
  const filePath = join(event.parent, event.name);
  const relativePath = relative(config.filesPath, filePath);
  const bookDataDir = join(config.dataPath, relativePath);

  const sourceExists = yield* fs
    .exists(filePath)
    .pipe(Effect.mapError((cause) => new BookCleanupSourceProbeFailed(failure(filePath, cause))));

  if (sourceExists) {
    logger.debug("BookCleanup", "Source exists, skipping stale delete", { path: relativePath });

    return [];
  }

  logger.info("BookCleanup", "Removing", { path: relativePath });

  yield* fs.rm(bookDataDir, { recursive: true }).pipe(
    Effect.catchTag("FileSystemNotFound", () =>
      Effect.sync(() => {
        logger.debug("BookCleanup", "Already removed", { path: relativePath });
      }),
    ),
    Effect.mapError((cause) => new BookCleanupRemoveFailed(failure(bookDataDir, cause))),
  );

  logger.info("BookCleanup", "Done", { path: relativePath });

  return [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(bookDataDir) })];
});

function failure(path: string, cause: FileSystemError): FailureProps {
  return { path, cause, message: cause.message };
}
