import {
  readComicFileMetadata,
  type ComicInfo,
  type CoMet,
  type ComicBookInfo,
  type MetadataCompiled,
} from "comic-metadata-tool";
import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { listEntries, readEntry } from "../utils/archive.ts";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

function formatDateFromNumbers(year?: number, month?: number): string | undefined {
  if (!year) return undefined;
  if (month) return `${year}-${String(month).padStart(2, "0")}`;
  return String(year);
}

function formatDateFromISO(date?: string): string | undefined {
  if (!date) return undefined;
  const match = date.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!match) return undefined;
  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}

function formatSeriesFromComicInfo(info: ComicInfo): string | undefined {
  const parts: string[] = [];
  if (info.series) parts.push(info.series);
  if (info.volume) parts.push(`Vol.${info.volume}`);
  if (info.number) parts.push(`#${info.number}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function formatSeriesFromCoMet(comet: CoMet): string | undefined {
  const parts: string[] = [];
  if (comet.series) parts.push(comet.series);
  if (comet.volume) parts.push(`Vol.${comet.volume}`);
  if (comet.issue) parts.push(`#${comet.issue}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function formatSeriesFromCBI(payload: ComicBookInfo["ComicBookInfo/1.0"]): string | undefined {
  const parts: string[] = [];
  if (payload.series) parts.push(payload.series);
  if (payload.volume) parts.push(`Vol.${payload.volume}`);
  if (payload.issue) parts.push(`#${payload.issue}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function parseGenresString(genre?: string): string[] | undefined {
  if (!genre) return undefined;
  const genres = genre.split(",").map((s) => s.trim()).filter(Boolean);
  return genres.length > 0 ? genres : undefined;
}

function getWriterFromCredits(credits?: { person: string; role: string }[]): string | undefined {
  if (!credits || credits.length === 0) return undefined;
  const writer = credits.find((c) => c.role.toLowerCase() === "writer");
  return writer?.person;
}

function extractFromComicInfo(info: ComicInfo): BookMetadata {
  return {
    title: info.title || info.series || "",
    author: info.writer || info.penciller || info.coverArtist,
    description: info.summary,
    publisher: info.publisher,
    issued: formatDateFromNumbers(info.year, info.month),
    language: info.languageISO,
    subjects: parseGenresString(info.genre),
    pageCount: info.pageCount,
    series: formatSeriesFromComicInfo(info),
  };
}

function extractFromCoMet(comet: CoMet): BookMetadata {
  return {
    title: comet.title || comet.series || "",
    author: comet.writer?.[0] || comet.creator?.[0] || comet.penciller?.[0],
    description: comet.description,
    publisher: comet.publisher,
    issued: formatDateFromISO(comet.date),
    language: comet.language,
    subjects: comet.genre,
    series: formatSeriesFromCoMet(comet),
    rights: comet.rights,
  };
}

function extractFromComicBookInfo(cbi: ComicBookInfo): BookMetadata {
  const payload = cbi["ComicBookInfo/1.0"];
  return {
    title: payload.title || payload.series || "",
    author: getWriterFromCredits(payload.credits),
    description: payload.comments,
    publisher: payload.publisher,
    issued: formatDateFromNumbers(payload.publicationYear, payload.publicationMonth),
    language: payload.language,
    subjects: payload.tags?.length > 0 ? payload.tags : parseGenresString(payload.genre),
    series: formatSeriesFromCBI(payload),
  };
}

function mergeMetadata(compiled: MetadataCompiled): BookMetadata {
  const comicInfo = compiled.comicInfoXml ? extractFromComicInfo(compiled.comicInfoXml) : null;
  const comet = compiled.coMet ? extractFromCoMet(compiled.coMet) : null;
  const cbi = compiled.comicbookinfo ? extractFromComicBookInfo(compiled.comicbookinfo) : null;

  const sources = [comicInfo, comet, cbi].filter(Boolean) as BookMetadata[];

  if (sources.length === 0) {
    return { title: "" };
  }

  const result: BookMetadata = { title: "" };

  for (const source of sources) {
    if (!result.title && source.title) result.title = source.title;
    if (!result.author && source.author) result.author = source.author;
    if (!result.description && source.description) result.description = source.description;
    if (!result.publisher && source.publisher) result.publisher = source.publisher;
    if (!result.issued && source.issued) result.issued = source.issued;
    if (!result.language && source.language) result.language = source.language;
    if (!result.subjects && source.subjects) result.subjects = source.subjects;
    if (!result.pageCount && source.pageCount) result.pageCount = source.pageCount;
    if (!result.series && source.series) result.series = source.series;
    if (!result.rights && source.rights) result.rights = source.rights;
  }

  return result;
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

async function createComicHandler(filePath: string): Promise<FormatHandler | null> {
  try {
    const compiled = await readComicFileMetadata(filePath);
    const metadata = mergeMetadata(compiled);
    const pages = compiled.comicInfoXml?.pages;

    const entries = await listEntries(filePath);
    const images = entries.filter((e) =>
      IMAGE_EXTENSIONS.some((ext) => e.toLowerCase().endsWith(ext))
    );

    return {
      getMetadata() {
        return metadata;
      },

      async getCover() {
        const coverPath = selectCoverImage(images, pages);
        if (!coverPath) return null;
        return readEntry(filePath, coverPath);
      },
    };
  } catch {
    return null;
  }
}

export const comicHandlerRegistration: FormatHandlerRegistration = {
  extensions: ["cbz", "cbr", "cb7", "zip"],
  create: createComicHandler,
};
