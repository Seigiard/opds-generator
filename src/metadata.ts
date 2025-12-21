import { basename, join } from "node:path";
import { readdir, unlink, mkdir } from "node:fs/promises";
import type { FileInfo, BookMeta } from "./types.ts";
import { MIME_TYPES } from "./types.ts";
import { computeFileHash } from "./scanner.ts";
import { extractEpubMeta } from "./epub.ts";
import { extractCbzMeta } from "./cbz.ts";
import { extractZipEntry, listZipEntries } from "./zip.ts";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

const COVERS_DIR = "covers";
const THUMBNAILS_DIR = "thumbnails";

type ZipContentType = "comic" | "fb2" | "unknown";

async function detectZipType(zipPath: string): Promise<ZipContentType> {
  const entries = await listZipEntries(zipPath);

  if (entries.some((e) => e.toLowerCase().endsWith(".fb2"))) {
    return "fb2";
  }

  const images = entries.filter((e) =>
    IMAGE_EXTENSIONS.some((ext) => e.toLowerCase().endsWith(ext))
  );

  if (images.length > 0 && images.length / entries.length >= 0.5) {
    return "comic";
  }

  return "unknown";
}

export async function extractBasicMeta(file: FileInfo): Promise<BookMeta> {
  const fileName = basename(file.relativePath);
  const titleFromFilename = fileName.replace(/\.[^.]+$/, "");
  const mimeType = MIME_TYPES[file.extension] ?? "application/octet-stream";
  const hash = computeFileHash(file);

  let title = titleFromFilename;
  let author: string | undefined;
  let description: string | undefined;

  let coverSourcePath: string | undefined;

  if (file.extension === "epub") {
    const epub = await extractEpubMeta(file.path);
    title = epub.title || titleFromFilename;
    author = epub.author;
    description = epub.description;
    coverSourcePath = epub.coverPath;
  }

  if (file.extension === "cbz" || file.extension === "cbr") {
    const cbz = await extractCbzMeta(file.path);
    title = cbz.title || titleFromFilename;
    author = cbz.author;
    coverSourcePath = cbz.coverPath;
  }

  if (file.extension === "zip") {
    const zipType = await detectZipType(file.path);

    if (zipType === "comic") {
      const cbz = await extractCbzMeta(file.path);
      title = cbz.title || titleFromFilename;
      author = cbz.author;
      coverSourcePath = cbz.coverPath;
    }
    // TODO: fb2.zip handling if needed
  }

  return {
    title,
    author,
    description,
    format: file.extension.toUpperCase(),
    mimeType,
    filePath: file.relativePath,
    fileSize: file.size,
    hash,
    coverSourcePath,
  };
}

async function resizeImage(
  srcPath: string,
  destPath: string,
  maxSize: number
): Promise<boolean> {
  try {
    const resize = `${maxSize}x${maxSize}>`;
    await Bun.$`magick ${srcPath} -resize ${resize} -colorspace sRGB -quality 90 ${destPath}`.quiet();
    return true;
  } catch {
    return false;
  }
}

const COVER_MAX_SIZE = 1400;
const THUMBNAIL_MAX_SIZE = 512;

async function extractCover(
  zipPath: string,
  coverEntryPath: string,
  relativePath: string,
  dataPath: string
): Promise<boolean> {
  try {
    const coversDir = join(dataPath, COVERS_DIR);
    const thumbnailsDir = join(dataPath, THUMBNAILS_DIR);
    await mkdir(coversDir, { recursive: true });
    await mkdir(thumbnailsDir, { recursive: true });

    const coverFilename = coverFilenameFor(relativePath);
    const coverDestPath = join(coversDir, coverFilename);
    const thumbnailDestPath = join(thumbnailsDir, coverFilename);

    await extractZipEntry(zipPath, coverEntryPath, coverDestPath);
    await resizeImage(coverDestPath, coverDestPath, COVER_MAX_SIZE);

    const thumbnailOk = await resizeImage(coverDestPath, thumbnailDestPath, THUMBNAIL_MAX_SIZE);
    if (!thumbnailOk) {
      await Bun.write(thumbnailDestPath, Bun.file(coverDestPath));
    }

    return true;
  } catch {
    return false;
  }
}

export async function extractCoverLazy(
  meta: BookMeta,
  filesPath: string,
  dataPath: string
): Promise<boolean> {
  if (await hasCover(meta.filePath, dataPath)) {
    return true;
  }

  const fullPath = join(filesPath, meta.filePath);
  let coverSourcePath = meta.coverSourcePath;

  if (!coverSourcePath) {
    coverSourcePath = await detectCoverPath(fullPath, meta.format.toLowerCase());
  }

  if (!coverSourcePath) {
    return false;
  }

  return extractCover(fullPath, coverSourcePath, meta.filePath, dataPath);
}

async function detectCoverPath(filePath: string, format: string): Promise<string | undefined> {
  if (format === "epub") {
    const epub = await extractEpubMeta(filePath);
    return epub.coverPath;
  }

  if (format === "cbz" || format === "cbr" || format === "zip") {
    const cbz = await extractCbzMeta(filePath);
    return cbz.coverPath;
  }

  return undefined;
}

function coverFilenameFor(relativePath: string): string {
  const hash = Bun.hash(relativePath).toString(16).slice(0, 16);
  const name = basename(relativePath);
  return `${hash}-${name}.jpg`;
}

export async function hasCover(
  relativePath: string,
  dataPath: string
): Promise<boolean> {
  const coverFilename = coverFilenameFor(relativePath);
  const coverPath = join(dataPath, COVERS_DIR, coverFilename);
  return await Bun.file(coverPath).exists();
}

export function getCoverPath(relativePath: string, dataPath: string): string {
  const coverFilename = coverFilenameFor(relativePath);
  return join(dataPath, COVERS_DIR, coverFilename);
}

export function getThumbnailPath(relativePath: string, dataPath: string): string {
  const coverFilename = coverFilenameFor(relativePath);
  return join(dataPath, THUMBNAILS_DIR, coverFilename);
}

export async function hasThumbnail(
  relativePath: string,
  dataPath: string
): Promise<boolean> {
  const thumbnailPath = getThumbnailPath(relativePath, dataPath);
  return await Bun.file(thumbnailPath).exists();
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RAW_DIR = "raw";

function shortHash(path: string): string {
  return Bun.hash(path).toString(16).slice(0, 16);
}

export function metaFilename(relativePath: string): string {
  const hash = shortHash(relativePath);
  const name = basename(relativePath);
  return `${hash}-${name}.json`;
}

function rawPath(dataPath: string): string {
  return join(dataPath, RAW_DIR);
}

export async function readCachedMeta(
  dataPath: string,
  relativePath: string
): Promise<BookMeta | null> {
  const filename = metaFilename(relativePath);
  const file = Bun.file(join(rawPath(dataPath), filename));

  if (await file.exists()) {
    return file.json();
  }
  return null;
}

export async function writeCachedMeta(
  dataPath: string,
  relativePath: string,
  meta: BookMeta
): Promise<void> {
  const dir = rawPath(dataPath);
  await mkdir(dir, { recursive: true });
  const filename = metaFilename(relativePath);
  await Bun.write(join(dir, filename), JSON.stringify(meta, null, 2));
}

export async function deleteCachedMeta(
  dataPath: string,
  relativePath: string
): Promise<void> {
  const filename = metaFilename(relativePath);
  try {
    await unlink(join(rawPath(dataPath), filename));
  } catch {
  }
}

export async function listCachedMeta(
  dataPath: string
): Promise<Map<string, BookMeta>> {
  const dir = rawPath(dataPath);
  const result = new Map<string, BookMeta>();

  try {
    const files = await readdir(dir);
    for (const filename of files) {
      if (!filename.endsWith(".json")) continue;
      const file = Bun.file(join(dir, filename));
      const meta: BookMeta = await file.json();
      result.set(meta.filePath, meta);
    }
  } catch {
  }

  return result;
}
