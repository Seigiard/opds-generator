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

class FolderCleanupSourceProbeFailed extends Data.TaggedError("FolderCleanupSourceProbeFailed")<FailureProps> {}

class FolderCleanupRemoveFailed extends Data.TaggedError("FolderCleanupRemoveFailed")<FailureProps> {}

/** Only a missing data dir is a recovered removal error. */
export const folderCleanupEffect = Effect.fn("folderCleanup")(function* (event: EventType) {
  if (!Predicate.isTagged(event, "FolderDeleted")) return [];

  const { config, logger } = yield* CatalogueDeps;
  const fs = yield* EffectFileSystem;
  const folderPath = join(event.parent, event.name);
  const relativePath = relative(config.filesPath, folderPath);
  const folderDataDir = join(config.dataPath, relativePath);

  // A delete event can be stale: the source may have come back since it was queued.
  const sourceExists = yield* fs
    .exists(folderPath)
    .pipe(Effect.mapError((cause) => new FolderCleanupSourceProbeFailed(failure(folderPath, cause))));

  if (sourceExists) {
    logger.debug("FolderCleanup", "Source exists, skipping stale delete", { path: relativePath });

    return [];
  }

  logger.info("FolderCleanup", "Removing", { path: relativePath });

  yield* fs.rm(folderDataDir, { recursive: true }).pipe(
    Effect.catchTag("FileSystemNotFound", () =>
      Effect.sync(() => {
        logger.debug("FolderCleanup", "Already removed", { path: relativePath });
      }),
    ),
    Effect.mapError((cause) => new FolderCleanupRemoveFailed(failure(folderDataDir, cause))),
  );

  logger.info("FolderCleanup", "Done", { path: relativePath });

  if (relativePath === "") return [];

  return [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(folderDataDir) })];
});

function failure(path: string, cause: FileSystemError): FailureProps {
  return { path, cause, message: cause.message };
}
