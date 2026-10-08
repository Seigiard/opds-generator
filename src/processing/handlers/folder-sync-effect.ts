import { Data, Effect, Predicate } from "effect";
import { dirname, join, relative } from "node:path";
import { EffectFileSystem } from "../../effect-file-system.ts";
import { ENTRY_FILE } from "../../constants.ts";
import { BOOK_EXTENSIONS } from "../../types.ts";
import { CatalogueDeps, CatalogueEvent } from "../effect-handler.ts";
import type { EventType } from "../types.ts";
import { publishFolderFeed } from "./folder-meta-sync-effect.ts";

interface FailureProps {
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}

class FolderSyncFailed extends Data.TaggedError("FolderSyncFailed")<FailureProps> {}

export const folderSyncEffect = Effect.fn("folderSync")(function* (event: EventType) {
  if (!Predicate.isTagged(event, "FolderCreated")) return [];

  const { config, logger } = yield* CatalogueDeps;
  const fs = yield* EffectFileSystem;
  const { parent, name } = event;
  const folderPath = join(parent, name);
  const relativePath = relative(config.filesPath, folderPath);
  const folderDataDir = join(config.dataPath, relativePath);

  logger.info("FolderSync", "Processing", { path: relativePath || "(root)" });

  yield* fs.mkdir(folderDataDir, { recursive: true }).pipe(Effect.mapError((cause) => new FolderSyncFailed(failure(folderDataDir, cause))));

  if (relativePath === "") {
    logger.info("FolderSync", "Root folder - no _entry.xml needed");

    return [CatalogueEvent.FolderMetaSyncRequested({ path: folderDataDir })];
  }

  // A successful directory read confirms this source and discovers files copied before its watch was installed.
  const discovered = yield* Effect.interruptible(discoverContents(folderPath, folderDataDir));

  // Publish the required child feed before its _entry.xml can be consumed by a parent.
  yield* publishFolderFeed(folderDataDir, relativePath);

  logger.info("FolderSync", "Done", { path: relativePath });

  // A new empty folder still needs its parent refreshed even when its summary stays unchanged.
  return [
    CatalogueEvent.FolderMetaSyncRequested({ path: folderDataDir }),
    CatalogueEvent.FolderMetaSyncRequested({ path: dirname(folderDataDir) }),
    ...discovered,
  ];
});

const discoverContents = Effect.fnUntraced(function* (folderPath: string, folderDataDir: string) {
  const fs = yield* EffectFileSystem;
  // inotifywait adds its watch to a new folder only after the create event, so anything copied in meanwhile raises no event.
  const names = yield* fs.readdir(folderPath).pipe(Effect.mapError((cause) => new FolderSyncFailed(failure(folderPath, cause))));
  const found: EventType[] = [];

  for (const name of names) {
    if (name.startsWith(".")) continue;

    const childPath = join(folderPath, name);
    const childStat = yield* fs.stat(childPath).pipe(Effect.mapError((cause) => new FolderSyncFailed(failure(childPath, cause))));

    if (childStat.isDirectory()) {
      found.push(CatalogueEvent.FolderCreated({ parent: folderPath, name }));
      continue;
    }

    const ext = name.split(".").pop()?.toLowerCase() ?? "";

    if (!BOOK_EXTENSIONS.includes(ext)) continue;

    const entryExists = yield* fs
      .exists(join(folderDataDir, name, ENTRY_FILE))
      .pipe(Effect.mapError((cause) => new FolderSyncFailed(failure(join(folderDataDir, name), cause))));

    // A book that got its own event is already processed or queued; skip it instead of extracting twice.
    if (!entryExists) found.push(CatalogueEvent.BookCreated({ parent: folderPath, name }));
  }

  return found;
});

function failure(path: string, cause: unknown): FailureProps {
  return { path, cause, message: cause instanceof Error ? cause.message : String(cause) };
}
