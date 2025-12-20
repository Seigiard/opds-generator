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

type ZipContentType = "comic" | "fb2" | "unknown";

/**
 * Определяет тип содержимого ZIP-архива
 */
async function detectZipType(zipPath: string): Promise<ZipContentType> {
  const entries = await listZipEntries(zipPath);

  // Есть .fb2 файл → это fb2.zip
  if (entries.some((e) => e.toLowerCase().endsWith(".fb2"))) {
    return "fb2";
  }

  // Считаем изображения
  const images = entries.filter((e) =>
    IMAGE_EXTENSIONS.some((ext) => e.toLowerCase().endsWith(ext))
  );

  // Если больше 50% файлов — изображения, это комикс
  if (images.length > 0 && images.length / entries.length >= 0.5) {
    return "comic";
  }

  return "unknown";
}

/**
 * Извлекает метаданные из файла (EPUB, CBZ или fallback на имя файла)
 */
export async function extractBasicMeta(
  file: FileInfo,
  dataPath?: string
): Promise<BookMeta> {
  const fileName = basename(file.relativePath);
  const titleFromFilename = fileName.replace(/\.[^.]+$/, "");
  const mimeType = MIME_TYPES[file.extension] ?? "application/octet-stream";
  const hash = computeFileHash(file);

  let title = titleFromFilename;
  let author: string | undefined;
  let description: string | undefined;

  // EPUB
  if (file.extension === "epub") {
    const epub = await extractEpubMeta(file.path);
    title = epub.title || titleFromFilename;
    author = epub.author;
    description = epub.description;

    // Извлекаем обложку
    if (dataPath && epub.coverPath) {
      await extractCover(file.path, epub.coverPath, file.relativePath, dataPath);
    }
  }

  // CBZ/CBR (комиксы)
  if (file.extension === "cbz" || file.extension === "cbr") {
    const cbz = await extractCbzMeta(file.path);
    title = cbz.title || titleFromFilename;
    author = cbz.author;

    // Извлекаем обложку
    if (dataPath && cbz.coverPath) {
      await extractCover(file.path, cbz.coverPath, file.relativePath, dataPath);
    }
  }

  // ZIP — определяем по содержимому (комикс или fb2)
  if (file.extension === "zip") {
    const zipType = await detectZipType(file.path);

    if (zipType === "comic") {
      const cbz = await extractCbzMeta(file.path);
      title = cbz.title || titleFromFilename;
      author = cbz.author;

      if (dataPath && cbz.coverPath) {
        await extractCover(file.path, cbz.coverPath, file.relativePath, dataPath);
      }
    }
    // TODO: fb2.zip обработка если нужно
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
  };
}

/**
 * Извлекает обложку из архива и сохраняет в data/covers/
 */
async function extractCover(
  zipPath: string,
  coverEntryPath: string,
  relativePath: string,
  dataPath: string
): Promise<void> {
  const coversDir = join(dataPath, COVERS_DIR);
  await mkdir(coversDir, { recursive: true });

  const coverFilename = coverFilenameFor(relativePath);
  const destPath = join(coversDir, coverFilename);

  await extractZipEntry(zipPath, coverEntryPath, destPath);
}

/**
 * Генерирует имя файла обложки
 */
function coverFilenameFor(relativePath: string): string {
  const hash = Bun.hash(relativePath).toString(16).slice(0, 8);
  const name = basename(relativePath);
  return `${hash}-${name}.jpg`;
}

/**
 * Проверяет существует ли обложка
 */
export async function hasCover(
  relativePath: string,
  dataPath: string
): Promise<boolean> {
  const coverFilename = coverFilenameFor(relativePath);
  const coverPath = join(dataPath, COVERS_DIR, coverFilename);
  return await Bun.file(coverPath).exists();
}

/**
 * Возвращает путь к обложке
 */
export function getCoverPath(relativePath: string, dataPath: string): string {
  const coverFilename = coverFilenameFor(relativePath);
  return join(dataPath, COVERS_DIR, coverFilename);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RAW_DIR = "raw";

/**
 * Генерирует короткий хэш от пути (первые 8 символов xxhash)
 */
function shortHash(path: string): string {
  return Bun.hash(path).toString(16).slice(0, 8);
}

/**
 * Генерирует имя JSON файла для кэша метаданных
 * "fiction/scifi/Foundation.epub" → "f8a2c1d3-Foundation.epub.json"
 */
export function metaFilename(relativePath: string): string {
  const hash = shortHash(relativePath);
  const name = basename(relativePath);
  return `${hash}-${name}.json`;
}

/**
 * Путь к директории кэша метаданных
 */
function rawPath(dataPath: string): string {
  return join(dataPath, RAW_DIR);
}

/**
 * Читает закэшированные метаданные файла
 */
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

/**
 * Записывает метаданные файла в кэш
 */
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

/**
 * Удаляет закэшированные метаданные файла
 */
export async function deleteCachedMeta(
  dataPath: string,
  relativePath: string
): Promise<void> {
  const filename = metaFilename(relativePath);
  try {
    await unlink(join(rawPath(dataPath), filename));
  } catch {
    // Файл уже удалён — ок
  }
}

/**
 * Возвращает Map: relativePath → BookMeta для всех закэшированных файлов
 */
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
    // Директория не существует — возвращаем пустой Map
  }

  return result;
}
