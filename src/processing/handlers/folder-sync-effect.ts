import { Data, Effect, Predicate } from "effect";
import { basename, dirname, join, relative } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { EffectFileSystem } from "../../effect-file-system.ts";
import { ENTRY_FILE, FEED_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";
import { BOOK_EXTENSIONS } from "../../types.ts";
import { encodeUrlPath, normalizeFilenameTitle } from "../../utils/processor.ts";
import { CatalogueDeps, CatalogueEvent } from "../effect-handler.ts";
import type { EventType } from "../types.ts";

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

  const folderName = normalizeFilenameTitle(basename(relativePath));
  const selfHref = `/${encodeUrlPath(relativePath)}/${FEED_FILE}`;
  const entry = new Entry(`urn:opds:catalog:${relativePath}`, folderName).addSubsection(selfHref, "navigation");

  yield* fs
    .atomicWrite(join(folderDataDir, FOLDER_ENTRY_FILE), entry.toXml({ prettyPrint: true }))
    .pipe(Effect.mapError((cause) => new FolderSyncFailed(failure(folderDataDir, cause))));

  logger.info("FolderSync", "Done", { path: relativePath });

  const discovered = yield* Effect.interruptible(discoverContents(folderPath, folderDataDir));

  return [
    CatalogueEvent.FolderMetaSyncRequested({ path: folderDataDir }),
    CatalogueEvent.FolderMetaSyncRequested({ path: dirname(folderDataDir) }),
    ...discovered,
  ];
});

const discoverContents = Effect.fnUntraced(function* (folderPath: string, folderDataDir: string) {
  const fs = yield* EffectFileSystem;
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

    const entryExists = yield* fs
      .exists(join(folderDataDir, name, ENTRY_FILE))
      .pipe(Effect.mapError((cause) => new FolderSyncFailed(failure(join(folderDataDir, name), cause))));

    if (BOOK_EXTENSIONS.includes(ext) && !entryExists) found.push(CatalogueEvent.BookCreated({ parent: folderPath, name }));
  }

  return found;
});

function failure(path: string, cause: unknown): FailureProps {
  return { path, cause, message: cause instanceof Error ? cause.message : String(cause) };
}
