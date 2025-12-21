import type { FormatHandler, BookMetadata } from "./types.ts";
import { readZipEntry, readZipEntryBinary } from "../utils/zip.ts";

export const epubHandler: FormatHandler = {
  extensions: ["epub"],

  async getMetadata(filePath: string): Promise<BookMetadata> {
    const container = await readZipEntry(filePath, "META-INF/container.xml");
    if (!container) return { title: "" };

    const opfPath = parseRootfile(container);
    if (!opfPath) return { title: "" };

    const opf = await readZipEntry(filePath, opfPath);
    if (!opf) return { title: "" };

    return {
      title: parseXmlTag(opf, "dc:title") ?? "",
      author: parseXmlTag(opf, "dc:creator"),
      description: parseDescription(opf),
    };
  },

  async getCover(filePath: string): Promise<Buffer | null> {
    const container = await readZipEntry(filePath, "META-INF/container.xml");
    if (!container) return null;

    const opfPath = parseRootfile(container);
    if (!opfPath) return null;

    const opf = await readZipEntry(filePath, opfPath);
    if (!opf) return null;

    const coverPath = parseCoverPath(opf, opfPath);
    if (!coverPath) return null;

    return readZipEntryBinary(filePath, coverPath);
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
