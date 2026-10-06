import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { createXmlParser, getString, getStringArray, cleanDescription } from "./utils.ts";
import { logHandlerError } from "../logging/index.ts";
import { listEntries, readEntryText } from "../utils/archive.ts";
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

async function readFb2Content(filePath: string, signal?: AbortSignal): Promise<string | null> {
  const ext = filePath.split(".").pop()?.toLowerCase();

  if (ext === "fbz" || filePath.toLowerCase().endsWith(".fb2.zip")) {
    const entries = await listEntries(filePath, signal);
    const fb2Entry = entries.find((e) => e.toLowerCase().endsWith(".fb2"));

    if (!fb2Entry) return null;

    return readEntryText(filePath, fb2Entry, signal);
  }

  return Bun.file(filePath).text();
}

async function createFb2Handler(filePath: string, signal?: AbortSignal): Promise<FormatHandler | null> {
  try {
    signal?.throwIfAborted();
    const content = await readFb2Content(filePath, signal);
    signal?.throwIfAborted();

    if (!content) return null;

    const doc = v.parse(xmlFieldsSchema, xmlParser.parse(content));
    const book = xmlFields(doc.FictionBook);

    if (!book) return null;

    const metadata = extractMetadata(book);
    const info = xmlFields(xmlFields(book.description)?.["title-info"]);
    const coverHref = xmlFields(xmlFields(info?.coverpage)?.image)?.["@_href"];
    const coverId = extractCoverId(v.is(xmlStringSchema, coverHref) ? coverHref : undefined);

    return {
      getMetadata() {
        return metadata;
      },
      async getCover() {
        if (!coverId) return null;

        return getCoverBuffer(book, coverId);
      },
    };
  } catch (error) {
    signal?.throwIfAborted();
    logHandlerError("FB2", filePath, error);

    return null;
  }
}

export const fb2HandlerRegistration: FormatHandlerRegistration = {
  extensions: ["fb2", "fbz"],
  create: createFb2Handler,
};
