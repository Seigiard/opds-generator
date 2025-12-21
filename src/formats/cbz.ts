import type { FormatHandler, BookMetadata } from "./types.ts";
import { readZipEntry, readZipEntryBinary, listZipEntries } from "../utils/zip.ts";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

export const cbzHandler: FormatHandler = {
  extensions: ["cbz", "cbr"],

  async getMetadata(filePath: string): Promise<BookMetadata> {
    const comicInfo = await readZipEntry(filePath, "ComicInfo.xml");

    return {
      title: comicInfo ? parseXmlTag(comicInfo, "Title") ?? "" : "",
      author: comicInfo ? parseXmlTag(comicInfo, "Writer") : undefined,
    };
  },

  async getCover(filePath: string): Promise<Buffer | null> {
    const entries = await listZipEntries(filePath);
    const images = entries
      .filter((e) => IMAGE_EXTENSIONS.some((ext) => e.toLowerCase().endsWith(ext)))
      .sort();

    if (images.length === 0) return null;

    return readZipEntryBinary(filePath, images[0]);
  },
};

function parseXmlTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  const match = xml.match(regex);
  return match?.[1]?.trim();
}
