import { mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { Entry } from "opds-ts/v1.2";
import type { FileInfo, BookEntry } from "./types.ts";
import { MIME_TYPES } from "./types.ts";
import { getHandlerFactory } from "./formats/index.ts";
import type { BookMetadata } from "./formats/types.ts";
import { saveBufferAsImage, COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "./utils/image.ts";
import { encodeUrlPath, formatFileSize, normalizeFilenameTitle } from "./utils/processor.ts";
import { config } from "./config.ts";
import { scheduleFeedRegeneration } from "./feed-watcher.ts";

export { encodeUrlPath, formatFileSize, normalizeFilenameTitle };

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

  // Trigger feed regeneration for parent folder
  const parentFolder = file.relativePath.split("/").slice(0, -1).join("/");
  scheduleFeedRegeneration(parentFolder);

  return bookEntry;
}

export async function processFolder(folderPath: string, dataPath: string, baseUrl: string): Promise<void> {
  const folderDataDir = join(dataPath, folderPath);
  await mkdir(folderDataDir, { recursive: true });

  // Only create _entry.xml for non-root folders (for parent's feed)
  if (folderPath !== "") {
    const folderName = folderPath.split("/").pop() || "Catalog";
    const entry = new Entry(`urn:opds:catalog:${folderPath}`, folderName).addSubsection(
      `${baseUrl}/opds/${encodeUrlPath(folderPath)}`,
      "navigation",
    );

    const entryXml = entry.toXml({ prettyPrint: true });
    await Bun.write(join(folderDataDir, "_entry.xml"), entryXml);
  }

  // Trigger feed regeneration for this folder
  scheduleFeedRegeneration(folderPath);
}

export async function cleanupOrphan(dataPath: string, relativePath: string): Promise<void> {
  const fullPath = join(dataPath, relativePath);
  try {
    await rm(fullPath, { recursive: true });
    // Trigger feed regeneration for parent folder
    const parentFolder = relativePath.split("/").slice(0, -1).join("/");
    scheduleFeedRegeneration(parentFolder);
  } catch {
    // Already deleted or doesn't exist
  }
}
