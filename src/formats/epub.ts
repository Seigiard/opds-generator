import type { FormatHandler, BookMetadata } from "./types.ts";
import { readEntry, readEntryText } from "../utils/archive.ts";

export const epubHandler: FormatHandler = {
  extensions: ["epub"],

  async getMetadata(filePath: string): Promise<BookMetadata> {
    const container = await readEntryText(filePath, "META-INF/container.xml");
    if (!container) return { title: "" };

    const opfPath = parseRootfile(container);
    if (!opfPath) return { title: "" };

    const opf = await readEntryText(filePath, opfPath);
    if (!opf) return { title: "" };

    return {
      title: parseXmlTag(opf, "dc:title") ?? "",
      author: parseXmlTag(opf, "dc:creator"),
      description: parseDescription(opf),
      publisher: parseXmlTag(opf, "dc:publisher"),
      issued: parseDate(opf),
      language: parseXmlTag(opf, "dc:language"),
      subjects: parseSubjects(opf),
      rights: parseXmlTag(opf, "dc:rights"),
    };
  },

  async getCover(filePath: string): Promise<Buffer | null> {
    const container = await readEntryText(filePath, "META-INF/container.xml");
    if (!container) return null;

    const opfPath = parseRootfile(container);
    if (!opfPath) return null;

    const opf = await readEntryText(filePath, opfPath);
    if (!opf) return null;

    const coverPath = parseCoverPath(opf, opfPath);
    if (!coverPath) return null;

    return readEntry(filePath, coverPath);
  },
};

function parseRootfile(xml: string): string | null {
  const match = xml.match(/rootfile[^>]+full-path="([^"]+)"/);
  return match?.[1] ?? null;
}

function parseXmlTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  const match = xml.match(regex);
  return match?.[1]?.trim();
}

function parseDescription(xml: string): string | undefined {
  const raw = parseXmlTag(xml, "dc:description");
  if (!raw) return undefined;

  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCoverPath(opf: string, opfPath: string): string | undefined {
  const coverMeta = opf.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/);
  if (!coverMeta) return undefined;

  const coverId = coverMeta[1];

  const itemRegex = new RegExp(`<item[^>]+id="${coverId}"[^>]+href="([^"]+)"`, "i");
  const itemMatch = opf.match(itemRegex);
  if (!itemMatch) return undefined;

  const coverHref = itemMatch[1];

  const opfDir = opfPath.replace(/[^/]+$/, "");
  return opfDir + coverHref;
}

function parseDate(opf: string): string | undefined {
  const date = parseXmlTag(opf, "dc:date");
  if (!date) return undefined;
  const match = date.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!match) return undefined;
  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}

function parseSubjects(opf: string): string[] | undefined {
  const regex = /<dc:subject[^>]*>([^<]+)<\/dc:subject>/gi;
  const subjects: string[] = [];
  let match;
  while ((match = regex.exec(opf)) !== null) {
    if (match[1]) subjects.push(match[1].trim());
  }
  return subjects.length > 0 ? subjects : undefined;
}
