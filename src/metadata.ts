import { basename, join } from "node:path";
import { readdir, unlink, mkdir } from "node:fs/promises";
import type { FileInfo, BookMeta } from "./types.ts";
import { MIME_TYPES } from "./types.ts";
import { computeFileHash } from "./scanner.ts";

export function extractBasicMeta(file: FileInfo): BookMeta {
  const fileName = basename(file.relativePath);
  const title = fileName.replace(/\.[^.]+$/, "");
  const mimeType = MIME_TYPES[file.extension] ?? "application/octet-stream";
  const hash = computeFileHash(file);

  return {
    title,
    format: file.extension.toUpperCase(),
    mimeType,
    filePath: file.relativePath,
    fileSize: file.size,
    hash,
  };
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
