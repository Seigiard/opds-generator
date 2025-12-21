import { mkdir, rm } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import type { FileInfo, BookEntry } from "./types.ts";
import { MIME_TYPES } from "./types.ts";
import { getHandler } from "./formats/index.ts";
import { saveBufferAsImage, COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "./utils/image.ts";

export async function processBook(
  file: FileInfo,
  filesPath: string,
  dataPath: string
): Promise<BookEntry> {
  const bookDataDir = join(dataPath, file.relativePath);
  await mkdir(bookDataDir, { recursive: true });

  const handler = getHandler(file.extension);
  let title = basename(file.relativePath).replace(/\.[^.]+$/, "");
  let author: string | undefined;
  let description: string | undefined;
  let hasCover = false;

  if (handler) {
    const meta = await handler.getMetadata(file.path);
    if (meta.title) title = meta.title;
    author = meta.author;
    description = meta.description;

    const coverBuffer = await handler.getCover(file.path);
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

  const entry: BookEntry = {
    title,
    author,
    description,
    format: file.extension.toUpperCase(),
    mimeType: MIME_TYPES[file.extension] ?? "application/octet-stream",
    filePath: file.relativePath,
    fileSize: file.size,
    hasCover,
  };

  const entryXml = buildBookEntryXml(entry, process.env.BASE_URL || "http://localhost:8080");
  await Bun.write(join(bookDataDir, "entry.xml"), entryXml);

  return entry;
}

export async function processFolder(
  folderPath: string,
  dataPath: string,
  baseUrl: string
): Promise<void> {
  const folderDataDir = join(dataPath, folderPath);
  await mkdir(folderDataDir, { recursive: true });

  const folderName = folderPath.split("/").pop() || "Catalog";
  const feedXml = buildFeedHeaderXml(folderName, folderPath, baseUrl);
  await Bun.write(join(folderDataDir, "_feed.xml"), feedXml);

  if (folderPath !== "") {
    const entryXml = buildFolderEntryXml(folderName, folderPath, baseUrl);
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

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function buildFeedHeaderXml(title: string, path: string, baseUrl: string): string {
  const id = path === "" ? "urn:opds:catalog:root" : `urn:opds:catalog:${path}`;
  const selfHref = path === "" ? `${baseUrl}/opds` : `${baseUrl}/opds/${encodeUrlPath(path)}`;
  const updated = new Date().toISOString();

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:dc="http://purl.org/dc/terms/">
  <id>${escapeXml(id)}</id>
  <title>${escapeXml(title)}</title>
  <updated>${updated}</updated>
  <link rel="self" href="${escapeXml(selfHref)}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${baseUrl}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
</feed>`;
}

function buildFolderEntryXml(title: string, path: string, baseUrl: string): string {
  const id = `urn:opds:catalog:${path}`;
  const href = `${baseUrl}/opds/${encodeUrlPath(path)}`;
  const updated = new Date().toISOString();

  return `  <entry>
    <id>${escapeXml(id)}</id>
    <title>${escapeXml(title)}</title>
    <updated>${updated}</updated>
    <link rel="subsection" href="${escapeXml(href)}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>`;
}

function buildBookEntryXml(entry: BookEntry, baseUrl: string): string {
  const id = `urn:opds:book:${entry.filePath}`;
  const updated = new Date().toISOString();
  const encodedPath = encodeUrlPath(entry.filePath);

  let xml = `  <entry>
    <id>${escapeXml(id)}</id>
    <title>${escapeXml(entry.title)}</title>
    <updated>${updated}</updated>`;

  if (entry.author) {
    xml += `
    <author><name>${escapeXml(entry.author)}</name></author>`;
  }

  xml += `
    <dc:format>${escapeXml(entry.format)}</dc:format>
    <content type="text">${formatFileSize(entry.fileSize)}</content>`;

  if (entry.hasCover) {
    xml += `
    <link rel="http://opds-spec.org/image" href="${baseUrl}/cover/${encodedPath}" type="image/jpeg"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${baseUrl}/thumbnail/${encodedPath}" type="image/jpeg"/>`;
  }

  xml += `
    <link rel="http://opds-spec.org/acquisition/open-access" href="${baseUrl}/download/${encodedPath}" type="${escapeXml(entry.mimeType)}"/>
  </entry>`;

  return xml;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
