import { Effect } from "effect";
import { ExtractionFailed, type BookMetadata, type ExtractedBook, type FormatExtractorRegistration } from "./types.ts";
import { createXmlParser, getString, getStringArray, cleanDescription } from "./utils.ts";
import { logHandlerError } from "../logging/index.ts";
import { listArchiveEntries, readArchiveEntryText } from "../utils/archive.ts";
import * as v from "valibot";
import { xmlFields, xmlFieldsSchema, xmlStringSchema, xmlNumberSchema, xmlBooleanSchema } from "./xml-value.ts";
import type { XmlValue, XmlFields } from "./xml-value.ts";

const xmlParser = createXmlParser(["author", "genre", "binary"]);

function formatAuthor(author: XmlFields): string {
  const parts = [author["first-name"], author["middle-name"], author["last-name"]];
  const name = parts.filter(Boolean).join(" ");
  const nickname = author.nickname;

  return name || (nickname && v.is(v.union([xmlStringSchema, xmlNumberSchema, xmlBooleanSchema]), nickname) ? String(nickname) : "");
}

function extractCoverId(href: string | undefined): string | undefined {
  if (!href) return undefined;

  return href.startsWith("#") ? href.slice(1) : href;
}

function extractTextFromNode(node: XmlValue | undefined): string {
  if (!node) return "";

  if (v.is(xmlStringSchema, node)) return node;

  if (v.is(xmlNumberSchema, node)) return String(node);

  if (Array.isArray(node)) return node.map(extractTextFromNode).join(" ");

  const fields = xmlFields(node);

  if (fields) {
    const texts: string[] = [];

    for (const value of Object.values(fields)) {
      const text = extractTextFromNode(value);

      if (text) texts.push(text);
    }

    return texts.join(" ");
  }

  return "";
}

function getAnnotationText(annotation: XmlValue | undefined): string | undefined {
  if (!annotation) return undefined;
  const text = extractTextFromNode(annotation).trim();

  return text || undefined;
}

function extractMetadata(book: XmlFields): BookMetadata {
  const description = xmlFields(book.description);
  const info = xmlFields(description?.["title-info"]);
  const pub = xmlFields(description?.["publish-info"]);

  const dateVal = info?.date;

  const dateFields = xmlFields(dateVal);
  const dateStr = dateFields ? (dateFields["@_value"] ?? dateFields["#text"]) : dateVal;
  const author = Array.isArray(info?.author) ? xmlFields(info.author[0]) : undefined;

  return {
    title: getString(info?.["book-title"]) ?? "",
    author: author ? formatAuthor(author) : undefined,
    description: cleanDescription(getAnnotationText(info?.annotation)),
    publisher: getString(pub?.publisher),
    issued: getString(dateStr),
    language: getString(info?.lang),
    subjects: getStringArray(info?.genre),
    series: getString(xmlFields(info?.sequence)?.["@_name"]),
  };
}

function getCoverBuffer(book: XmlFields, coverId: string): Buffer | null {
  const binaries = Array.isArray(book.binary) ? book.binary : [];
  const cover = binaries.map(xmlFields).find((b) => b?.["@_id"] === coverId);

  if (!cover?.["#text"]) return null;

  try {
    const base64 = String(cover["#text"]).replace(/\s/g, "");

    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

const extractFb2 = Effect.fn("extractFb2")(function* (filePath: string) {
  const content = yield* readFb2Content(filePath);

  if (!content) return yield* ExtractionFailed.of(filePath, "no FB2 content");

  const book = parseBook(filePath, content);

  if (!book) return yield* ExtractionFailed.of(filePath, "not a readable FictionBook");

  return book;
});

export const fb2ExtractorRegistration: FormatExtractorRegistration = {
  extensions: ["fb2", "fbz"],
  extract: extractFb2,
};

function isArchived(filePath: string): boolean {
  const lower = filePath.toLowerCase();

  return lower.endsWith(".fbz") || lower.endsWith(".fb2.zip");
}

/** An archived book reads its first `.fb2` entry through the common archive dispatch, whatever the container. */
function readFb2Content(filePath: string): Effect.Effect<string | null, ExtractionFailed> {
  if (!isArchived(filePath)) return readPlainText(filePath);

  return listArchiveEntries(filePath).pipe(
    Effect.flatMap((entries) => {
      const fb2Entry = entries.find((e) => e.toLowerCase().endsWith(".fb2"));

      return fb2Entry ? readArchiveEntryText(filePath, fb2Entry) : Effect.succeed(null);
    }),
  );
}

/** The read runs to completion: a stop waits for it rather than abandoning it, and is observed after it settles. */
function readPlainText(filePath: string): Effect.Effect<string, ExtractionFailed> {
  return Effect.tryPromise({
    try: () => Bun.file(filePath).text(),
    catch: (cause) => ExtractionFailed.of(filePath, cause),
  }).pipe(
    Effect.uninterruptible,
    Effect.tapError((error) => Effect.sync(() => logHandlerError("FB2", filePath, error.cause))),
  );
}

/** Synchronous and not preemptible. Unparseable XML is logged and reads as no book. */
function parseBook(filePath: string, content: string): ExtractedBook | null {
  try {
    return parseFictionBook(content);
  } catch (error) {
    logHandlerError("FB2", filePath, error);

    return null;
  }
}

function parseFictionBook(content: string): ExtractedBook | null {
  const doc = v.parse(xmlFieldsSchema, xmlParser.parse(content));
  const book = xmlFields(doc.FictionBook);

  if (!book) return null;

  const info = xmlFields(xmlFields(book.description)?.["title-info"]);
  const coverHref = xmlFields(xmlFields(info?.coverpage)?.image)?.["@_href"];
  const coverId = extractCoverId(v.is(xmlStringSchema, coverHref) ? coverHref : undefined);

  return { meta: extractMetadata(book), cover: coverId ? getCoverBuffer(book, coverId) : null };
}
