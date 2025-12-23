import { XMLParser } from "fast-xml-parser";
import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { listEntries, readEntry, readEntryText } from "../utils/archive.ts";
import { getFirstString, getStringArray, cleanDescription, parseDate } from "./utils.ts";
import { logger } from "../utils/errors.ts";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ["Page", "writer", "creator", "penciller", "genre"].includes(name),
});

interface ComicInfoPage {
  "@_Image": string;
  "@_Type"?: string;
}

interface ComicInfoDoc {
  ComicInfo: {
    Title?: string;
    Series?: string;
    Number?: string;
    Volume?: string;
    Summary?: string;
    Publisher?: string;
    Year?: string;
    Month?: string;
    Writer?: string;
    Penciller?: string;
    CoverArtist?: string;
    Genre?: string;
    LanguageISO?: string;
    PageCount?: string;
    Pages?: { Page?: ComicInfoPage[] };
  };
}

interface CoMetDoc {
  comet: {
    title?: string;
    series?: string;
    issue?: string;
    volume?: string;
    description?: string;
    publisher?: string;
    date?: string;
    writer?: string[];
    creator?: string[];
    penciller?: string[];
    genre?: string[];
    language?: string;
    rights?: string;
  };
}

function formatDateFromNumbers(year?: number, month?: number): string | undefined {
  if (!year) return undefined;
  if (month) return `${year}-${String(month).padStart(2, "0")}`;
  return String(year);
}

function parseGenresString(genre?: string): string[] | undefined {
  if (!genre) return undefined;
  const genres = genre.split(",").map((s) => s.trim()).filter(Boolean);
  return genres.length > 0 ? genres : undefined;
}

function formatSeries(series?: string, volume?: string | number, number?: string | number): string | undefined {
  const parts: string[] = [];
  if (series) parts.push(series);
  if (volume) parts.push(`Vol.${volume}`);
  if (number) parts.push(`#${number}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function toStringOrUndefined(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  return undefined;
}

async function parseComicInfo(filePath: string, entries: string[]): Promise<{ metadata: BookMetadata; pages?: ComicInfoPage[] } | null> {
  const comicInfoPath = entries.find((e) => e.toLowerCase() === "comicinfo.xml");
  if (!comicInfoPath) return null;

  const content = await readEntryText(filePath, comicInfoPath);
  if (!content) return null;

  try {
    const doc = xmlParser.parse(content) as ComicInfoDoc;
    const info = doc.ComicInfo;
    if (!info) return null;

    const year = info.Year ? Number(info.Year) : undefined;
    const month = info.Month ? Number(info.Month) : undefined;
    const pageCount = info.PageCount ? Number(info.PageCount) : undefined;

    const metadata: BookMetadata = {
      title: toStringOrUndefined(info.Title) || toStringOrUndefined(info.Series) || "",
      author: toStringOrUndefined(info.Writer) || toStringOrUndefined(info.Penciller) || toStringOrUndefined(info.CoverArtist),
      description: cleanDescription(toStringOrUndefined(info.Summary)),
      publisher: toStringOrUndefined(info.Publisher),
      issued: formatDateFromNumbers(year, month),
      language: toStringOrUndefined(info.LanguageISO),
      subjects: parseGenresString(toStringOrUndefined(info.Genre)),
      pageCount: pageCount && !isNaN(pageCount) ? pageCount : undefined,
      series: formatSeries(toStringOrUndefined(info.Series), info.Volume, info.Number),
    };

    return { metadata, pages: info.Pages?.Page };
  } catch (error) {
    logger.warn("Comic", "Failed to parse ComicInfo.xml", { file: filePath, error: String(error) });
    return null;
  }
}

async function parseCoMet(filePath: string, entries: string[]): Promise<BookMetadata | null> {
  const cometPath = entries.find((e) => e.toLowerCase() === "comet.xml");
  if (!cometPath) return null;

  const content = await readEntryText(filePath, cometPath);
  if (!content) return null;

  try {
    const doc = xmlParser.parse(content) as CoMetDoc;
    const comet = doc.comet;
    if (!comet) return null;

    return {
      title: toStringOrUndefined(comet.title) || toStringOrUndefined(comet.series) || "",
      author: getFirstString(comet.writer) || getFirstString(comet.creator) || getFirstString(comet.penciller),
      description: cleanDescription(toStringOrUndefined(comet.description)),
      publisher: toStringOrUndefined(comet.publisher),
      issued: parseDate(toStringOrUndefined(comet.date)),
      language: toStringOrUndefined(comet.language),
      subjects: getStringArray(comet.genre),
      series: formatSeries(toStringOrUndefined(comet.series), comet.volume, comet.issue),
      rights: toStringOrUndefined(comet.rights),
    };
  } catch (error) {
    logger.warn("Comic", "Failed to parse CoMet.xml", { file: filePath, error: String(error) });
    return null;
  }
}

function mergeMetadata(...sources: (BookMetadata | null)[]): BookMetadata {
  const result: BookMetadata = { title: "" };

  for (const source of sources) {
    if (!source) continue;
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

function findCoverFromPages(pages: ComicInfoPage[] | undefined, images: string[]): string | undefined {
  if (!pages || pages.length === 0) return undefined;

  const frontCover = pages.find((p) => p["@_Type"] === "FrontCover");
  if (frontCover !== undefined) {
    const imageIndex = parseInt(frontCover["@_Image"], 10);
    const sortedImages = [...images].sort();
    if (!isNaN(imageIndex) && imageIndex < sortedImages.length) {
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

function selectCoverImage(images: string[], pages?: ComicInfoPage[]): string | undefined {
  if (images.length === 0) return undefined;

  const fromPages = findCoverFromPages(pages, images);
  if (fromPages) return fromPages;

  const byName = findCoverByName(images);
  if (byName) return byName;

  return [...images].sort()[0];
}

async function createComicHandler(filePath: string): Promise<FormatHandler | null> {
  const entries = await listEntries(filePath);
  if (entries.length === 0) return null;

  const images = entries.filter((e) =>
    IMAGE_EXTENSIONS.some((ext) => e.toLowerCase().endsWith(ext))
  );

  const [comicInfoResult, cometMetadata] = await Promise.all([
    parseComicInfo(filePath, entries),
    parseCoMet(filePath, entries),
  ]);

  const metadata = mergeMetadata(comicInfoResult?.metadata ?? null, cometMetadata);
  const pages = comicInfoResult?.pages;

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
}

export const comicHandlerRegistration: FormatHandlerRegistration = {
  extensions: ["cbz", "cbr", "cb7", "zip"],
  create: createComicHandler,
};
