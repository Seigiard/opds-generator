import { readdir, stat } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import type { FileInfo, FolderInfo } from "./types.ts";
import { BOOK_EXTENSIONS } from "./types.ts";

export async function scanFiles(rootPath: string): Promise<FileInfo[]> {
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

export function buildFolderStructure(files: FileInfo[]): FolderInfo[] {
  const folderSet = new Set<string>();
  folderSet.add("");

  for (const file of files) {
    const parts = file.relativePath.split("/");
    parts.pop();

    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      folderSet.add(currentPath);
    }
  }

  const folders: FolderInfo[] = [];

  for (const path of folderSet) {
    const subfolders = Array.from(folderSet).filter((f) => {
      if (f === path) return false;
      const prefix = path === "" ? "" : path + "/";
      if (!f.startsWith(prefix)) return false;
      const rest = f.slice(prefix.length);
      return !rest.includes("/");
    });

    folders.push({
      path,
      name: path.split("/").pop() || "Catalog",
      subfolders,
    });
  }

  return folders;
}

export async function scanDataMirror(dataPath: string): Promise<Set<string>> {
  const paths = new Set<string>();

  async function scan(dirPath: string, relativePath: string): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith("_")) continue;

        const entryPath = join(dirPath, entry.name);
        const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        const hasEntryXml = await Bun.file(join(entryPath, "entry.xml")).exists();
        const hasFeedXml = await Bun.file(join(entryPath, "_feed.xml")).exists();

        if (hasEntryXml) {
          paths.add(entryRelPath);
        } else if (hasFeedXml) {
          paths.add(entryRelPath);
          await scan(entryPath, entryRelPath);
        } else {
          await scan(entryPath, entryRelPath);
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  await scan(dataPath, "");
  return paths;
}

export interface SyncPlan {
  toProcess: FileInfo[];
  toDelete: string[];
  folders: FolderInfo[];
}

export async function createSyncPlan(
  files: FileInfo[],
  dataPath: string
): Promise<SyncPlan> {
  const folders = buildFolderStructure(files);
  const existingPaths = await scanDataMirror(dataPath);

  const currentFilePaths = new Set(files.map((f) => f.relativePath));
  const currentFolderPaths = new Set(folders.map((f) => f.path).filter((p) => p !== ""));

  const toProcess: FileInfo[] = [];
  const toDelete: string[] = [];

  for (const file of files) {
    const dataDir = join(dataPath, file.relativePath);
    const entryFile = Bun.file(join(dataDir, "entry.xml"));

    if (!(await entryFile.exists())) {
      toProcess.push(file);
    } else {
      const entryStat = await stat(join(dataDir, "entry.xml"));
      if (file.mtime > entryStat.mtimeMs) {
        toProcess.push(file);
      }
    }
  }

  for (const path of existingPaths) {
    if (!currentFilePaths.has(path) && !currentFolderPaths.has(path)) {
      toDelete.push(path);
    }
  }

  return { toProcess, toDelete, folders };
}

export function computeHash(files: FileInfo[]): string {
  const sorted = [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );

  const data = sorted
    .map((f) => `${f.relativePath}|${f.size}|${Math.floor(f.mtime)}`)
    .join("\n");

  return Bun.hash(data).toString(16);
}
