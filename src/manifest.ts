import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Manifest, ManifestDiff, FileInfo } from "./types.ts";
import { computeFileHash } from "./scanner.ts";

const MANIFEST_FILE = "manifest.json";

export async function readManifest(dataPath: string): Promise<Manifest | null> {
  const file = Bun.file(join(dataPath, MANIFEST_FILE));

  if (await file.exists()) {
    return file.json();
  }
  return null;
}

export async function writeManifest(
  dataPath: string,
  manifest: Manifest
): Promise<void> {
  const filePath = join(dataPath, MANIFEST_FILE);
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify(manifest, null, 2));
}

export function createManifest(files: FileInfo[], hash: string): Manifest {
  const fileIndex: Record<string, string> = {};
  const folders = new Set<string>();

  for (const file of files) {
    fileIndex[file.relativePath] = computeFileHash(file);

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

export function diffManifest(
  oldManifest: Manifest | null,
  newManifest: Manifest
): ManifestDiff {
  if (!oldManifest) {
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

  for (const [path, hash] of Object.entries(newFiles)) {
    if (!(path in oldFiles)) {
      added.push(path);
    } else if (oldFiles[path] !== hash) {
      changed.push(path);
    }
  }

  for (const path of Object.keys(oldFiles)) {
    if (!(path in newFiles)) {
      removed.push(path);
    }
  }

  return { added, removed, changed };
}

export function needsRebuild(
  oldManifest: Manifest | null,
  newHash: string
): boolean {
  if (!oldManifest) return true;
  return oldManifest.hash !== newHash;
}
