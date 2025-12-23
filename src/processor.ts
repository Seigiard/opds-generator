import { mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { Entry, Feed } from "opds-ts/v1.2";
import type { FileInfo, BookEntry } from "./types.ts";
import { MIME_TYPES } from "./types.ts";
import { getHandlerFactory } from "./formats/index.ts";
import type { BookMetadata } from "./formats/types.ts";
import { saveBufferAsImage, COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "./utils/image.ts";
import { config } from "./config.ts";

export function encodeUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function normalizeFilenameTitle(filename: string): string {
  return filename
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function processBook(file: FileInfo, filesPath: string, dataPath: string): Promise<BookEntry> {
  const bookDataDir = join(dataPath, file.relativePath);
  await mkdir(bookDataDir, { recursive: true });

  const createHandler = getHandlerFactory(file.extension);
  const rawFilename = basename(file.relativePath).replace(/\.[^.]+$/, "");
  let title = normalizeFilenameTitle(rawFilename);
  let author: string | undefined;
  let description: string | undefined;
  let hasCover = false;

  let meta: BookMetadata = { title: "" };

  if (createHandler) {
    const handler = await createHandler(file.path);
    if (handler) {
      meta = handler.getMetadata();
      if (meta.title) title = meta.title;
      author = meta.author;
      description = meta.description;

      const coverBuffer = await handler.getCover();
      if (coverBuffer) {
        const coverPath = join(bookDataDir, "cover.jpg");
        const thumbPath = join(bookDataDir, "thumb.jpg");

        const coverOk = await saveBufferAsImage(coverBuffer, coverPath, COVER_MAX_SIZE);
        if (coverOk) {
          await saveBufferAsImage(coverBuffer, thumbPath, THUMBNAIL_MAX_SIZE);
          hasCover = true;
        }
      }
    }
  }

  const bookEntry: BookEntry = {
    title,
    author,
    description,
    format: file.extension.toUpperCase(),
    mimeType: MIME_TYPES[file.extension] ?? "application/octet-stream",
    filePath: file.relativePath,
    fileSize: file.size,
    hasCover,
  };

  const encodedPath = encodeUrlPath(file.relativePath);

  const entry = new Entry(`urn:opds:book:${file.relativePath}`, title);
  if (author) entry.setAuthor(author);
  if (description) entry.setSummary(description);
  entry.setDcMetadataField("format", bookEntry.format);
  entry.setContent({ type: "text", value: formatFileSize(file.size) });

  if (meta.publisher) entry.setDcMetadataField("publisher", meta.publisher);
  if (meta.issued) entry.setDcMetadataField("issued", meta.issued);
  if (meta.language) entry.setDcMetadataField("language", meta.language);
  if (meta.subjects) entry.setDcMetadataField("subjects", meta.subjects);
  if (meta.pageCount) entry.setDcMetadataField("extent", `${meta.pageCount} pages`);
  if (meta.series) entry.setDcMetadataField("isPartOf", meta.series);
  if (meta.rights) entry.setRights(meta.rights);

  if (hasCover) {
    entry.addImage(`${config.baseUrl}/cover/${encodedPath}`);
    entry.addThumbnail(`${config.baseUrl}/thumbnail/${encodedPath}`);
  }

  entry.addAcquisition(`${config.baseUrl}/download/${encodedPath}`, bookEntry.mimeType, "open-access");

  const entryXml = entry.toXml({ prettyPrint: true });
  await Bun.write(join(bookDataDir, "entry.xml"), entryXml);

  return bookEntry;
}

export async function processFolder(folderPath: string, dataPath: string, baseUrl: string): Promise<void> {
  const folderDataDir = join(dataPath, folderPath);
  await mkdir(folderDataDir, { recursive: true });

  const folderName = folderPath.split("/").pop() || "Catalog";
  const feedId = folderPath === "" ? "urn:opds:catalog:root" : `urn:opds:catalog:${folderPath}`;
  const selfHref = folderPath === "" ? `${baseUrl}/opds` : `${baseUrl}/opds/${encodeUrlPath(folderPath)}`;

  const feed = new Feed(feedId, folderName)
    .setKind("navigation")
    .addSelfLink(selfHref, "navigation")
    .addNavigationLink("start", `${baseUrl}/opds`);

  const feedXml = feed.toXml({ prettyPrint: true });
  await Bun.write(join(folderDataDir, "_feed.xml"), feedXml);

  if (folderPath !== "") {
    const entry = new Entry(`urn:opds:catalog:${folderPath}`, folderName).addSubsection(
      `${baseUrl}/opds/${encodeUrlPath(folderPath)}`,
      "navigation",
    );

    const entryXml = entry.toXml({ prettyPrint: true });
    await Bun.write(join(folderDataDir, "_entry.xml"), entryXml);
  }
}

export async function cleanupOrphan(dataPath: string, relativePath: string): Promise<void> {
  const fullPath = join(dataPath, relativePath);
  try {
    await rm(fullPath, { recursive: true });
  } catch {
    // Already deleted or doesn't exist
  }
}
