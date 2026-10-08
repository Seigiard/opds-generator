import sharp from "sharp";
import { Data, Effect } from "effect";
import { join } from "node:path";
import { ExtractionFailed, type BookMetadata, type ExtractedBook, type FormatExtractorRegistration } from "./types.ts";
import { logHandlerError } from "../logging/index.ts";
import { COVER_MAX_SIZE } from "../constants.ts";
import { runCommand, runCommandText, useTemporaryDirectory } from "../utils/process.ts";

interface DjvuMeta {
  title?: string;
  author?: string;
  keywords?: string;
  creationDate?: string;
  pages?: number;
}

interface CommandText {
  readonly stdout: string;
  readonly exitCode: number;
}

// `message` carries the cause's text: the logger writes an error's message and stack, never its `cause`.
class CoverConversionFailed extends Data.TaggedError("CoverConversionFailed")<{ readonly cause: unknown; readonly message: string }> {}

const extractDjvu = Effect.fn("extractDjvu")(function* (filePath: string) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(filePath).exists(),
    catch: (cause) => ExtractionFailed.of(filePath, cause),
  }).pipe(
    Effect.tapError((error) => Effect.sync(() => logHandlerError("DJVU", filePath, error.cause))),
    Effect.uninterruptible,
  );

  if (!exists) return yield* ExtractionFailed.of(filePath, "file does not exist");

  const info = yield* readDjvuMeta(filePath);

  const meta: BookMetadata = {
    title: info.title || "",
    author: info.author,
    issued: parseCreationDate(info.creationDate),
    subjects: parseKeywords(info.keywords),
    pageCount: info.pages,
  };

  const book: ExtractedBook = { meta, cover: yield* readCover(filePath) };

  return book;
});

export const djvuExtractorRegistration: FormatExtractorRegistration = {
  extensions: ["djvu"],
  extract: extractDjvu,
};

/**
 * Metadata and page count come from two concurrent `djvused` commands. If one fails to run, the other is
 * interrupted and awaited. One nonzero exit keeps what the other command read; two nonzero exits fail.
 */
function readDjvuMeta(filePath: string): Effect.Effect<DjvuMeta, ExtractionFailed> {
  return Effect.all([djvused(filePath, "print-meta"), djvused(filePath, "n")], { concurrency: 2 }).pipe(
    Effect.tapError((error) => Effect.sync(() => logHandlerError("DJVU", filePath, error.cause))),
    Effect.mapError((error) => ExtractionFailed.of(filePath, error)),
    Effect.flatMap(([metaResult, pagesResult]) => {
      const info = parseDjvuOutputs(metaResult, pagesResult);

      return info ? Effect.succeed(info) : Effect.fail(ExtractionFailed.of(filePath, "djvused read neither metadata nor page count"));
    }),
  );
}

function djvused(filePath: string, script: string) {
  return runCommandText({ command: ["djvused", filePath, "-e", script] });
}

/** The first page as JPEG. A cover that cannot be rendered is `null`, so the metadata already read survives. */
function readCover(filePath: string): Effect.Effect<Buffer | null> {
  return useTemporaryDirectory("djvu-", (directory) => renderFirstPage(filePath, join(directory, "page.tiff"))).pipe(
    Effect.catchTags({
      CommandFailed: (error) => recoverCover(filePath, error.cause),
      TemporaryDirectoryFailed: (error) => recoverCover(filePath, error.cause),
      CoverConversionFailed: (error) => recoverCover(filePath, error.cause),
    }),
  );
}

const renderFirstPage = Effect.fnUntraced(function* (filePath: string, tiffPath: string) {
  const { exitCode } = yield* runCommand({ command: ["ddjvu", "-format=tiff", "-page=1", filePath, tiffPath] });

  if (exitCode !== 0) return null;

  const data = yield* convertToCover(tiffPath);

  return data.byteLength === 0 ? null : data;
});

// sharp cannot be cancelled. Uninterruptible, so removal of the temporary TIFF waits until sharp stops reading it.
function convertToCover(tiffPath: string): Effect.Effect<Buffer, CoverConversionFailed> {
  return Effect.tryPromise({
    try: () =>
      sharp(tiffPath).resize(COVER_MAX_SIZE, COVER_MAX_SIZE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer(),
    catch: (cause) => new CoverConversionFailed({ cause, message: cause instanceof Error ? cause.message : String(cause) }),
  }).pipe(Effect.uninterruptible);
}

function recoverCover(filePath: string, cause: unknown): Effect.Effect<null> {
  return Effect.sync(() => {
    logHandlerError("DJVU", filePath, cause);

    return null;
  });
}

function parseDjvuOutputs(metaResult: CommandText, pagesResult: CommandText): DjvuMeta | null {
  if (metaResult.exitCode !== 0 && pagesResult.exitCode !== 0) return null;

  const meta = parseMetaOutput(metaResult.stdout);

  if (pagesResult.exitCode === 0) {
    const pages = parseInt(pagesResult.stdout.trim(), 10);

    if (!isNaN(pages)) meta.pages = pages;
  }

  return meta;
}

function parseMetaOutput(output: string): DjvuMeta {
  const meta: DjvuMeta = {};

  for (const line of output.split("\n")) {
    const tabIndex = line.indexOf("\t");

    if (tabIndex === -1) continue;

    const key = line.slice(0, tabIndex).trim();
    const value = parseMetaValue(line.slice(tabIndex + 1));

    if (!value) continue;

    switch (key) {
      case "Title":
        meta.title = value;
        break;
      case "Author":
        meta.author = value;
        break;
      case "Keywords":
        meta.keywords = value;
        break;
      case "CreationDate":
        meta.creationDate = value;
        break;
    }
  }

  return meta;
}

function parseMetaValue(value: string): string {
  return value.replace(/^"(.*)"$/, "$1").trim();
}

function parseKeywords(keywords: string | undefined): string[] | undefined {
  if (!keywords) return undefined;

  const items = keywords
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

function parseCreationDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;

  const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);

  return yearMatch ? yearMatch[0] : undefined;
}
