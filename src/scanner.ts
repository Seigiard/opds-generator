import { readdir, stat } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import type { FileInfo, FolderInfo } from "./types.ts";
import { BOOK_EXTENSIONS } from "./types.ts";

/**
 * Рекурсивно сканирует директорию и возвращает информацию о файлах книг
 */
export async function scanDirectory(rootPath: string): Promise<FileInfo[]> {
  const files: FileInfo[] = [];

  async function scan(dirPath: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).slice(1).toLowerCase();

        if (BOOK_EXTENSIONS.includes(ext)) {
          const fileStat = await stat(fullPath);
          files.push({
            path: fullPath,
            relativePath: relative(rootPath, fullPath),
            size: fileStat.size,
            mtime: fileStat.mtimeMs,
            extension: ext,
          });
        }
      }
    }
  }

  await scan(rootPath);
  return files;
}

/**
 * Собирает структуру папок из списка файлов
 */
export function buildFolderStructure(
  rootPath: string,
  files: FileInfo[]
): FolderInfo[] {
  const folderMap = new Map<string, FolderInfo>();

  // Создаём корневую папку
  folderMap.set("", {
    path: "",
    name: "Каталог",
    subfolders: [],
    files: [],
  });

  for (const file of files) {
    const parts = file.relativePath.split("/");
    parts.pop(); // Убираем имя файла

    // Создаём все промежуточные папки
    let currentPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === undefined) continue;

      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!folderMap.has(currentPath)) {
        folderMap.set(currentPath, {
          path: currentPath,
          name: part,
          subfolders: [],
          files: [],
        });

        // Добавляем в родительскую папку
        const parent = folderMap.get(parentPath);
        if (parent && !parent.subfolders.includes(currentPath)) {
          parent.subfolders.push(currentPath);
        }
      }
    }

    // Добавляем файл в его папку
    const folderPath = parts.join("/");
    const folder = folderMap.get(folderPath);
    if (folder) {
      folder.files.push(file);
    }
  }

  return Array.from(folderMap.values());
}

/**
 * Вычисляет хэш каталога на основе stat данных файлов.
 * НЕ читает содержимое файлов — только path + size + mtime.
 */
export function computeHash(files: FileInfo[]): string {
  // Сортируем для стабильного хэша
  const sorted = [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );

  // Формируем строку: path|size|mtime для каждого файла
  const data = sorted
    .map((f) => `${f.relativePath}|${f.size}|${Math.floor(f.mtime)}`)
    .join("\n");

  // Используем встроенный Bun.hash (xxhash — быстрый)
  return Bun.hash(data).toString(16);
}

/**
 * Вычисляет хэш отдельного файла
 */
export function computeFileHash(file: FileInfo): string {
  const data = `${file.relativePath}|${file.size}|${Math.floor(file.mtime)}`;
  return Bun.hash(data).toString(16);
}
