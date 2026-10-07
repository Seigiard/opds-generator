import { Effect } from "effect";
import { ExtractionFailed, type BookMetadata, type ExtractedBook, type FormatExtractorRegistration } from "./types.ts";
import { logHandlerError } from "../logging/index.ts";
import { COVER_MAX_SIZE } from "../constants.ts";
import { runCommand, runCommandText } from "../utils/process.ts";

const SOURCE_FILE_EXTENSIONS = /\.(indd|qxd|docx?|odt|rtf|pages|tex|pub|wpd|fm)$/i;

interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creationDate?: string;
  pages?: number;
}

const extractPdf = Effect.fn("extractPdf")(function* (filePath: string) {
  const exists = yield* Effect.promise(() => Bun.file(filePath).exists()).pipe(Effect.uninterruptible);

  if (!exists) return yield* ExtractionFailed.of(filePath, "file does not exist");

  const info = yield* readPdfInfo(filePath);

  const meta: BookMetadata = {
    title: stripSourceFileExtension(info.title || ""),
    author: info.author,
    description: info.subject,
    issued: parseCreationDate(info.creationDate),
    subjects: parseKeywords(info.keywords),
    pageCount: info.pages && !isNaN(info.pages) ? info.pages : undefined,
  };

  const book: ExtractedBook = { meta, cover: yield* readCover(filePath) };

  return book;
});

export const pdfExtractorRegistration: FormatExtractorRegistration = {
  extensions: ["pdf"],
  extract: extractPdf,
};

function readPdfInfo(filePath: string): Effect.Effect<PdfInfo, ExtractionFailed> {
  return runCommandText({ command: ["pdfinfo", filePath] }).pipe(
    Effect.tapError((error) => Effect.sync(() => logHandlerError("PDF", filePath, error.cause))),
    Effect.mapError((error) => ExtractionFailed.of(filePath, error)),
    Effect.flatMap(({ stdout, exitCode }) =>
      exitCode === 0
        ? Effect.succeed(parsePdfInfoOutput(stdout))
        : Effect.fail(ExtractionFailed.of(filePath, `pdfinfo exited with ${exitCode}`)),
    ),
  );
}

/** The first page as JPEG. A cover that cannot be rendered is `null`, so the metadata already read survives. */
function readCover(filePath: string): Effect.Effect<Buffer | null> {
  return runCommand({
    command: ["pdftoppm", "-jpeg", "-f", "1", "-l", "1", "-scale-to", String(COVER_MAX_SIZE), filePath],
  }).pipe(
    Effect.map(({ stdout, exitCode }) => (exitCode !== 0 || stdout.byteLength === 0 ? null : Buffer.from(stdout))),
    Effect.catchTag("CommandFailed", (error) =>
      Effect.sync(() => {
        logHandlerError("PDF", filePath, error.cause);

        return null;
      }),
    ),
  );
}

export function parsePdfInfoOutput(output: string): PdfInfo {
  const info: PdfInfo = {};
  const lines = output.split("\n");

  for (const line of lines) {
    // Indented lines belong to sub-blocks like "PDF subtype" whose own
    // Title (e.g. "ISO 15930 - ...") must not override the document title
    if (/^\s/.test(line)) continue;

    const colonIndex = line.indexOf(":");

    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (!value) continue;

    switch (key) {
      case "Title":
        info.title = value;
        break;
      case "Author":
        info.author = value;
        break;
      case "Subject":
        info.subject = value;
        break;
      case "Keywords":
        info.keywords = value;
        break;
      case "CreationDate":
        info.creationDate = value;
        break;
      case "Pages":
        info.pages = parseInt(value, 10);
        break;
    }
  }

  return info;
}

export function stripSourceFileExtension(title: string): string {
  return title.replace(SOURCE_FILE_EXTENSIONS, "");
}

function parseCreationDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;

  const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);

  return yearMatch ? yearMatch[0] : undefined;
}

function parseKeywords(keywords: string | undefined): string[] | undefined {
  if (!keywords) return undefined;

  const items = keywords
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}
