import { Data, Effect, Predicate } from "effect";
import { dirname, join, relative } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { EffectFileSystem } from "../../effect-file-system.ts";
import { ENTRY_FILE, FEED_FILE, FOLDER_ENTRY_FILE, INDEX_FILE } from "../../constants.ts";
import { buildFeedModel } from "../../render/feed-model.ts";
import { renderHtml } from "../../render/feed-html.ts";
import { renderXml } from "../../render/feed-xml.ts";
import { extractAuthor, extractTitle, naturalSort, stripXmlDeclaration } from "../../utils/opds.ts";
import { encodeUrlPath, formatFolderDescription, normalizeFilenameTitle } from "../../utils/processor.ts";
import { CatalogueDeps, CatalogueEvent } from "../effect-handler.ts";
import { ownedPromise } from "../../utils/owned-promise.ts";
import type { EventType } from "../types.ts";

interface EntryWithTitle {
  readonly xml: string;
  readonly title: string;
  readonly author?: string;
  readonly dirName: string;
}

interface FolderEntries {
  readonly folderEntries: EntryWithTitle[];
  readonly bookEntries: EntryWithTitle[];
}

interface FailureProps {
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}

const EMPTY_ENTRIES: FolderEntries = {
  folderEntries: [],
  bookEntries: [],
};

class FolderFeedPublishFailed extends Data.TaggedError("FolderFeedPublishFailed")<FailureProps> {}

class FolderEntryPublishFailed extends Data.TaggedError("FolderEntryPublishFailed")<FailureProps> {}

class FolderEntryReadFailed extends Data.TaggedError("FolderEntryReadFailed")<FailureProps> {}

export const folderMetaSyncEffect = Effect.fn("folderMetaSync")(function* (event: EventType) {
  if (!Predicate.isTagged(event, "FolderMetaSyncRequested")) return [];

  const { config, logger } = yield* CatalogueDeps;
  const fs = yield* EffectFileSystem;
  const normalizedDir = event.path.endsWith("/") ? event.path.slice(0, -1) : event.path;
  const relativePath = relative(config.dataPath, normalizedDir);

  if (relativePath !== "") {
    const sourceFolder = join(config.filesPath, relativePath);

    const sourceExists = yield* fs.stat(sourceFolder).pipe(
      Effect.map((s) => s.isDirectory()),
      Effect.catch(() => Effect.succeed(false)),
    );

    if (!sourceExists) {
      logger.debug("FolderMetaSync", "Skipping (source folder deleted)", { path: relativePath });

      return [];
    }
  }

  return yield* publishFolderFeed(normalizedDir, relativePath);
});

/** Shared safe publication after the caller confirms the source folder. */
export const publishFolderFeed = Effect.fnUntraced(function* (normalizedDir: string, relativePath: string) {
  const { logger } = yield* CatalogueDeps;
  const fs = yield* EffectFileSystem;

  logger.info("FolderMetaSync", "Processing", { path: relativePath || "(root)" });

  const { folderEntries, bookEntries } = yield* readFolderEntries(normalizedDir).pipe(
    Effect.catch((error) => {
      logger.warn("FolderMetaSync", "Error reading folder", { path: relativePath, error: String(error) });

      return Effect.succeed(EMPTY_ENTRIES);
    }),
  );

  folderEntries.sort(sortByTitle);
  bookEntries.sort(sortByAuthorTitle);

  const entries = [...folderEntries.map((e) => e.xml), ...bookEntries.map((e) => e.xml)];
  const hasBooks = bookEntries.length > 0;
  const feedKind = hasBooks ? "acquisition" : "navigation";
  const feedOutputPath = join(normalizedDir, FEED_FILE);
  const rawFolderName = relativePath.split("/").pop() || "Catalog";
  const folderName = rawFolderName === "Catalog" ? rawFolderName : normalizeFilenameTitle(rawFolderName);
  const feedId = relativePath === "" ? "urn:opds:catalog:root" : `urn:opds:catalog:${relativePath}`;
  const selfHref = relativePath === "" ? `/${FEED_FILE}` : `/${encodeUrlPath(relativePath)}/${FEED_FILE}`;

  const model = buildFeedModel({
    id: feedId,
    title: folderName,
    updated: new Date().toISOString(),
    kind: feedKind,
    selfHref,
    startHref: `/${FEED_FILE}`,
    fragments: entries,
  });

  yield* fs
    .atomicWrite(feedOutputPath, renderXml(model))
    .pipe(Effect.mapError((cause) => new FolderFeedPublishFailed(failure(feedOutputPath, cause))));

  logger.info("FolderMetaSync", "Generated feed.xml", {
    path: relativePath || "/",
    subfolders: folderEntries.length,
    books: bookEntries.length,
  });

  yield* fs.atomicWrite(join(normalizedDir, INDEX_FILE), renderHtml(model)).pipe(
    Effect.tap(() => Effect.sync(() => logger.debug("FolderMetaSync", "Generated index.html", { path: relativePath || "/" }))),
    Effect.catch((htmlError) =>
      Effect.sync(() => logger.error("FolderMetaSync", "Failed to render index.html", htmlError, { path: relativePath || "/" })),
    ),
  );

  if (relativePath === "") return [];

  const entryOutputPath = join(normalizedDir, FOLDER_ENTRY_FILE);
  const entry = new Entry(`urn:opds:catalog:${relativePath}`, folderName).addSubsection(selfHref, "navigation");
  const description = formatFolderDescription(folderEntries.length, bookEntries.length);

  if (description) entry.setSummary(description);

  const entryXml = entry.toXml({ prettyPrint: true });

  const entryExists = yield* fs
    .exists(entryOutputPath)
    .pipe(Effect.mapError((cause) => new FolderEntryReadFailed(failure(entryOutputPath, cause))));

  const previousXml = entryExists
    ? yield* ownedPromise(
        () => Bun.file(entryOutputPath).text(),
        (cause) => new FolderEntryReadFailed(failure(entryOutputPath, cause)),
      )
    : undefined;

  if (previousXml !== undefined && withoutTimestamp(previousXml) === withoutTimestamp(entryXml)) {
    logger.debug("FolderMetaSync", "_entry.xml unchanged, parent not refreshed", { path: relativePath });

    return [];
  }

  yield* fs
    .atomicWrite(entryOutputPath, entryXml)
    .pipe(Effect.mapError((cause) => new FolderEntryPublishFailed(failure(entryOutputPath, cause))));
  logger.debug("FolderMetaSync", "Updated _entry.xml count", { path: relativePath });

  return [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(normalizedDir) })];
});

const readFolderEntries = Effect.fnUntraced(function* (normalizedDir: string) {
  const fs = yield* EffectFileSystem;
  const folderEntries: EntryWithTitle[] = [];
  const bookEntries: EntryWithTitle[] = [];
  const items = yield* fs.readdir(normalizedDir);

  for (const item of items) {
    if (item.startsWith("_") || item === FEED_FILE || item.endsWith(".tmp")) continue;

    const itemPath = join(normalizedDir, item);
    const itemStat = yield* fs.stat(itemPath);

    if (!itemStat.isDirectory()) continue;

    const folderEntryPath = join(itemPath, FOLDER_ENTRY_FILE);
    const bookEntryPath = join(itemPath, ENTRY_FILE);

    if (yield* fs.exists(folderEntryPath)) {
      const entryXml = yield* ownedPromise(
        () => Bun.file(folderEntryPath).text(),
        (cause) => new FolderEntryReadFailed(failure(folderEntryPath, cause)),
      );

      const xml = stripXmlDeclaration(entryXml);
      const title = extractTitle(xml) || item;
      folderEntries.push({ xml, title, dirName: item });
    } else if (yield* fs.exists(bookEntryPath)) {
      const entryXml = yield* ownedPromise(
        () => Bun.file(bookEntryPath).text(),
        (cause) => new FolderEntryReadFailed(failure(bookEntryPath, cause)),
      );

      const xml = stripXmlDeclaration(entryXml);
      const title = extractTitle(xml) || item;
      const author = extractAuthor(xml);
      bookEntries.push({ xml, title, author, dirName: item });
    }
  }

  return { folderEntries, bookEntries };
});

const sortByTitle = (a: EntryWithTitle, b: EntryWithTitle): number => {
  const cmp = naturalSort(a.title, b.title);

  return cmp !== 0 ? cmp : naturalSort(a.dirName, b.dirName);
};

const sortByAuthorTitle = (a: EntryWithTitle, b: EntryWithTitle): number => {
  if (!a.author && b.author) return -1;

  if (a.author && !b.author) return 1;

  if (a.author && b.author) {
    const authorCmp = naturalSort(a.author, b.author);

    if (authorCmp !== 0) return authorCmp;
  }

  const titleCmp = naturalSort(a.title, b.title);

  return titleCmp !== 0 ? titleCmp : naturalSort(a.dirName, b.dirName);
};

// opds-ts stamps every Entry with a fresh <updated>, so raw output never equals the previous file.
const withoutTimestamp = (entryXml: string): string => entryXml.replace(/<updated>[^<]*<\/updated>/, "");

function failure(path: string, cause: unknown): FailureProps {
  return { path, cause, message: cause instanceof Error ? cause.message : String(cause) };
}
