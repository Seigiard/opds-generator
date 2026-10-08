import { Data, Effect, Predicate } from "effect";
import { join, relative, dirname } from "node:path";
import type { BookMetadata } from "../../formats/types.ts";
import { getExtractor } from "../../formats/index.ts";
import { saveCoverAndThumbnail, COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "../../utils/image.ts";
import { CatalogueDeps, CatalogueEvent } from "../effect-handler.ts";
import { ownedPromise } from "../../utils/owned-promise.ts";
import type { EventType } from "../types.ts";
import { ENTRY_FILE, COVER_FILE, THUMB_FILE } from "../../constants.ts";
import { bookEntryXml } from "./book-entry.ts";

// `message` carries the cause's text: the logger writes an error's message and stack, never its `cause`.
interface FailureProps {
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}

class BookStatFailed extends Data.TaggedError("BookStatFailed")<FailureProps> {}

class BookDataDirFailed extends Data.TaggedError("BookDataDirFailed")<FailureProps> {}

class EntryPublishFailed extends Data.TaggedError("EntryPublishFailed")<FailureProps> {}

/** Recovered inside `bookSync`: the book keeps its metadata and gets no cover. */
class CoverSaveFailed extends Data.TaggedError("CoverSaveFailed")<FailureProps> {}

const NO_METADATA: PreparedExtraction = { meta: { title: "" }, hasCover: false };

type PreparedExtraction =
  | { readonly meta: BookMetadata; readonly hasCover: boolean; readonly extractionError?: never }
  | { readonly extractionError: string; readonly meta?: never; readonly hasCover?: never };

/**
 * `bookSync` shutdown may interrupt only the preparation:
 * extraction runs in this fiber and every Promise boundary in it is owned, so an interrupted book waits for its
 * commands and native work to settle and leaves the previous `entry.xml` untouched. Publication runs in the uninterruptible handler
 * context, so both writes always finish.
 */
export const bookSyncEffect = Effect.fn("bookSync")(function* (event: EventType) {
  if (!Predicate.isTagged(event, "BookCreated")) return [];

  const { logger, fs } = yield* CatalogueDeps;
  const book = yield* Effect.interruptible(prepareBook(event.parent, event.name));

  if (book.entryXml === undefined) {
    logger.warn("BookSync", "Keeping previous entry after extraction failure", { path: book.relativePath, error: book.extractionError });

    return [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(book.dataDir) })];
  }

  yield* ownedPromise(
    async () => {
      await fs.symlink(book.filePath, join(book.dataDir, event.name));
      await fs.atomicWrite(join(book.dataDir, ENTRY_FILE), book.entryXml);
    },
    (cause) => new EntryPublishFailed(failure(book.dataDir, cause)),
  );
  logger.info("BookSync", "Done", { path: book.relativePath, has_cover: book.hasCover });

  return [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(book.dataDir) })];
});

const prepareBook = Effect.fnUntraced(function* (parent: string, name: string) {
  const { config, logger, fs } = yield* CatalogueDeps;
  const filePath = join(parent, name);
  const relativePath = relative(config.filesPath, filePath);
  const dataDir = join(config.dataPath, relativePath);

  logger.info("BookSync", "Processing", { path: relativePath });

  const fileStat = yield* ownedPromise(
    () => fs.stat(filePath),
    (cause) => new BookStatFailed(failure(filePath, cause)),
  );

  yield* ownedPromise(
    () => fs.mkdir(dataDir, { recursive: true }),
    (cause) => new BookDataDirFailed(failure(dataDir, cause)),
  );

  const extraction: PreparedExtraction = yield* extractMetadataAndCover(filePath, dataDir).pipe(
    Effect.catchTag("ExtractionFailed", (error) =>
      ownedPromise(
        () => fs.exists(join(dataDir, ENTRY_FILE)),
        (cause) => new BookStatFailed(failure(filePath, cause)),
      ).pipe(
        Effect.flatMap((published) =>
          published
            ? Effect.succeed<PreparedExtraction>({ extractionError: error.message })
            : Effect.succeed<PreparedExtraction>(NO_METADATA),
        ),
      ),
    ),
  );

  if (extraction.extractionError !== undefined) {
    return { filePath, relativePath, dataDir, hasCover: false, entryXml: undefined, extractionError: extraction.extractionError };
  }

  const { meta, hasCover } = extraction;

  return {
    filePath,
    relativePath,
    dataDir,
    hasCover,
    entryXml: bookEntryXml(relativePath, name, meta, hasCover, fileStat.size),
  };
});

const extractMetadataAndCover = Effect.fnUntraced(function* (filePath: string, bookDataDir: string) {
  const extension = filePath.toLowerCase().endsWith(".fb2.zip") ? "fb2" : (filePath.split(".").pop() ?? "");
  const extract = getExtractor(extension);

  if (!extract) return NO_METADATA;

  const { meta, cover } = yield* extract(filePath);

  if (!cover) return { meta, hasCover: false };

  const hasCover = yield* ownedPromise(
    () => saveCoverAndThumbnail(cover, join(bookDataDir, COVER_FILE), COVER_MAX_SIZE, join(bookDataDir, THUMB_FILE), THUMBNAIL_MAX_SIZE),
    (cause) => new CoverSaveFailed(failure(bookDataDir, cause)),
  ).pipe(Effect.catchTag("CoverSaveFailed", () => Effect.succeed(false)));

  return { meta, hasCover };
});

function failure(path: string, cause: unknown): FailureProps {
  return { path, cause, message: cause instanceof Error ? cause.message : String(cause) };
}
