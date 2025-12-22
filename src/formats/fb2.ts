import { XMLParser } from "fast-xml-parser";
import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { getString, getStringArray, cleanDescription } from "./utils.ts";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ["author", "genre", "binary"].includes(name),
});

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

function getAnnotationText(annotation: unknown): string | undefined {
  if (!annotation) return undefined;
  if (typeof annotation === "string") return annotation;
  if (typeof annotation === "object") {
    return JSON.stringify(annotation);
  }
  return undefined;
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

async function createFb2Handler(filePath: string): Promise<FormatHandler | null> {
  try {
    const content = await Bun.file(filePath).text();
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
  } catch {
    return null;
  }
}

export const fb2HandlerRegistration: FormatHandlerRegistration = {
  extensions: ["fb2"],
  create: createFb2Handler,
};
