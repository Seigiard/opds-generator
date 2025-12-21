import { readComicFileMetadata, type ComicInfo } from "comic-metadata-tool";
import type { FormatHandler, BookMetadata } from "./types.ts";
import { listEntries, readEntry } from "../utils/archive.ts";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

function formatDate(year?: number, month?: number): string | undefined {
  if (!year) return undefined;
  if (month) return `${year}-${String(month).padStart(2, "0")}`;
  return String(year);
}

function formatSeries(info: ComicInfo): string | undefined {
  const parts: string[] = [];
  if (info.series) parts.push(info.series);
  if (info.volume) parts.push(`Vol.${info.volume}`);
  if (info.number) parts.push(`#${info.number}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function getWriter(info: ComicInfo): string | undefined {
  return info.writer || info.penciller || info.coverArtist;
}

function parseGenres(genre?: string): string[] | undefined {
  if (!genre) return undefined;
  const genres = genre.split(",").map((s) => s.trim()).filter(Boolean);
  return genres.length > 0 ? genres : undefined;
}

function findCoverFromPages(pages: ComicInfo["pages"], images: string[]): string | undefined {
  if (!pages || pages.length === 0) return undefined;

  const frontCover = pages.find((p) => p.Type === "FrontCover");
  if (frontCover !== undefined) {
    const imageIndex = frontCover.Image;
    const sortedImages = [...images].sort();
    if (imageIndex < sortedImages.length) {
      return sortedImages[imageIndex];
    }
  }
  return undefined;
}

function findCoverByName(images: string[]): string | undefined {
  const patterns = [/cover/i, /front/i, /обложка/i, /^0+[01]?\./];

  for (const pattern of patterns) {
    const match = images.find((img) => pattern.test(img));
    if (match) return match;
  }
  return undefined;
}

function selectCoverImage(images: string[], pages?: ComicInfo["pages"]): string | undefined {
  if (images.length === 0) return undefined;

  const fromPages = findCoverFromPages(pages, images);
  if (fromPages) return fromPages;

  const byName = findCoverByName(images);
  if (byName) return byName;

  return [...images].sort()[0];
}

export const comicHandler: FormatHandler = {
  extensions: ["cbz", "cbr", "cb7", "zip"],

  async getMetadata(filePath: string): Promise<BookMetadata> {
    try {
      const compiled = await readComicFileMetadata(filePath);
      const info = compiled.comicInfoXml;

      if (!info) {
        return { title: "" };
      }

      return {
        title: info.title || info.series || "",
        author: getWriter(info),
        description: info.summary,
        publisher: info.publisher,
        issued: formatDate(info.year, info.month),
        language: info.languageISO,
        subjects: parseGenres(info.genre),
        pageCount: info.pageCount,
        series: formatSeries(info),
      };
    } catch {
      return { title: "" };
    }
  },

  async getCover(filePath: string): Promise<Buffer | null> {
    try {
      let pages: ComicInfo["pages"] | undefined;

      try {
        const compiled = await readComicFileMetadata(filePath);
        pages = compiled.comicInfoXml?.pages;
      } catch {
        // No metadata, will use heuristics
      }

      const entries = await listEntries(filePath);
      const images = entries.filter((e) =>
        IMAGE_EXTENSIONS.some((ext) => e.toLowerCase().endsWith(ext))
      );

      const coverPath = selectCoverImage(images, pages);
      if (!coverPath) return null;

      return readEntry(filePath, coverPath);
    } catch {
      return null;
    }
  },
};
