import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { createXmlParser, getString, getStringArray, cleanDescription } from "./utils.ts";
import { logHandlerError } from "../logging/index.ts";
import { listEntries, readEntryText } from "../utils/archive.ts";

const xmlParser = createXmlParser(["author", "genre", "binary"]);

interface FB2Author {
  "first-name"?: string;
  "middle-name"?: string;
  "last-name"?: string;
  nickname?: string;
}

interface FB2Binary {
  "@_id": string;
  "@_content-type"?: string;
  "#text": string;
}

interface FB2Document {
  FictionBook: {
    description?: {
      "title-info"?: {
        "book-title"?: string;
        author?: FB2Author[];
        genre?: string[];
        annotation?: unknown;
        date?: { "@_value"?: string; "#text"?: string } | string;
        lang?: string;
        coverpage?: { image?: { "@_href"?: string } };
        sequence?: { "@_name"?: string; "@_number"?: string };
      };
      "publish-info"?: {
        publisher?: string;
        year?: string;
      };
    };
    binary?: FB2Binary[];
  };
}

function formatAuthor(author: FB2Author): string {
  const parts = [author["first-name"], author["middle-name"], author["last-name"]];
  const name = parts.filter(Boolean).join(" ");
  return name || author.nickname || "";
}

function extractCoverId(href: string | undefined): string | undefined {
  if (!href) return undefined;
  return href.startsWith("#") ? href.slice(1) : href;
}

function extractTextFromNode(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractTextFromNode).join(" ");
  if (typeof node === "object") {
    const texts: string[] = [];
    for (const value of Object.values(node as Record<string, unknown>)) {
      const text = extractTextFromNode(value);
      if (text) texts.push(text);
    }
    return texts.join(" ");
  }
  return "";
}

function getAnnotationText(annotation: unknown): string | undefined {
  if (!annotation) return undefined;
  const text = extractTextFromNode(annotation).trim();
  return text || undefined;
}

function extractMetadata(doc: FB2Document): BookMetadata {
  const info = doc.FictionBook.description?.["title-info"];
  const pub = doc.FictionBook.description?.["publish-info"];

  const dateVal = info?.date;
  const dateStr = typeof dateVal === "object" ? (dateVal?.["@_value"] ?? dateVal?.["#text"]) : dateVal;

  return {
    title: getString(info?.["book-title"]) ?? "",
    author: info?.author?.[0] ? formatAuthor(info.author[0]) : undefined,
    description: cleanDescription(getAnnotationText(info?.annotation)),
    publisher: getString(pub?.publisher),
    issued: getString(dateStr),
    language: getString(info?.lang),
    subjects: getStringArray(info?.genre),
    series: getString(info?.sequence?.["@_name"]),
  };
}

function getCoverBuffer(doc: FB2Document, coverId: string): Buffer | null {
  const binaries = doc.FictionBook.binary ?? [];
  const cover = binaries.find((b) => b["@_id"] === coverId);
  if (!cover?.["#text"]) return null;

  try {
    const base64 = cover["#text"].replace(/\s/g, "");
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

async function readFb2Content(filePath: string): Promise<string | null> {
  const ext = filePath.split(".").pop()?.toLowerCase();

  if (ext === "fbz" || filePath.toLowerCase().endsWith(".fb2.zip")) {
    const entries = await listEntries(filePath);
    const fb2Entry = entries.find((e) => e.toLowerCase().endsWith(".fb2"));
    if (!fb2Entry) return null;
    return readEntryText(filePath, fb2Entry);
  }

  return Bun.file(filePath).text();
}

async function createFb2Handler(filePath: string): Promise<FormatHandler | null> {
  try {
    const content = await readFb2Content(filePath);
    if (!content) return null;

    const doc = xmlParser.parse(content) as FB2Document;

    if (!doc.FictionBook) return null;

    const metadata = extractMetadata(doc);
    const coverHref = doc.FictionBook.description?.["title-info"]?.coverpage?.image?.["@_href"];
    const coverId = extractCoverId(coverHref);

    return {
      getMetadata() {
        return metadata;
      },
      async getCover() {
        if (!coverId) return null;
        return getCoverBuffer(doc, coverId);
      },
    };
  } catch (error) {
    logHandlerError("FB2", filePath, error);
    return null;
  }
}

export const fb2HandlerRegistration: FormatHandlerRegistration = {
  extensions: ["fb2", "fbz"],
  create: createFb2Handler,
};
