import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Manifest, ManifestDiff, FileInfo } from "./types.ts";
import { computeFileHash } from "./scanner.ts";

const MANIFEST_FILE = "manifest.json";

/**
 * Читает манифест из $DATA/manifest.json
 * Возвращает null если файл не существует
 */
export async function readManifest(dataPath: string): Promise<Manifest | null> {
  const filePath = join(dataPath, MANIFEST_FILE);

  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Записывает манифест в $DATA/manifest.json
 */
export async function writeManifest(
  dataPath: string,
  manifest: Manifest
): Promise<void> {
  const filePath = join(dataPath, MANIFEST_FILE);

  // Создаём директорию если не существует
  await mkdir(dirname(filePath), { recursive: true });

  await writeFile(filePath, JSON.stringify(manifest, null, 2));
}

/**
 * Создаёт манифест из списка файлов
 */
export function createManifest(files: FileInfo[], hash: string): Manifest {
  const fileIndex: Record<string, string> = {};
  const folders = new Set<string>();

  for (const file of files) {
    fileIndex[file.relativePath] = computeFileHash(file);

    // Собираем уникальные папки
    const parts = file.relativePath.split("/");
    parts.pop();
    if (parts.length > 0) {
      folders.add(parts.join("/"));
    }
  }

  return {
    version: 1,
    hash,
    lastScan: Date.now(),
    files: fileIndex,
    folders: Array.from(folders).sort(),
  };
}

/**
 * Сравнивает два манифеста и возвращает различия
 */
export function diffManifest(
  oldManifest: Manifest | null,
  newManifest: Manifest
): ManifestDiff {
  if (!oldManifest) {
    // Первый запуск — все файлы новые
    return {
      added: Object.keys(newManifest.files),
      removed: [],
      changed: [],
    };
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  const oldFiles = oldManifest.files;
  const newFiles = newManifest.files;

  // Находим добавленные и изменённые
  for (const [path, hash] of Object.entries(newFiles)) {
    if (!(path in oldFiles)) {
      added.push(path);
    } else if (oldFiles[path] !== hash) {
      changed.push(path);
    }
  }

  // Находим удалённые
  for (const path of Object.keys(oldFiles)) {
    if (!(path in newFiles)) {
      removed.push(path);
    }
  }

  return { added, removed, changed };
}

/**
 * Проверяет нужен ли ребилд каталога
 */
export function needsRebuild(
  oldManifest: Manifest | null,
  newHash: string
): boolean {
  if (!oldManifest) return true;
  return oldManifest.hash !== newHash;
}
