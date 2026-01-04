import { createExtractorFromFile } from "node-unrar-js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout, spawnWithTimeoutText } from "./process.ts";

type ArchiveType = "zip" | "rar" | "7z" | "tar";

const MAGIC_BYTES: Record<Exclude<ArchiveType, "tar">, number[]> = {
  zip: [0x50, 0x4b, 0x03, 0x04],
  rar: [0x52, 0x61, 0x72, 0x21],
  "7z": [0x37, 0x7a, 0xbc, 0xaf],
};

const USTAR_MAGIC = [0x75, 0x73, 0x74, 0x61, 0x72]; // "ustar"

export async function detectArchiveType(filePath: string): Promise<ArchiveType | null> {
  try {
    const file = Bun.file(filePath);
    const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());

    for (const [type, magic] of Object.entries(MAGIC_BYTES) as [Exclude<ArchiveType, "tar">, number[]][]) {
      if (magic.every((byte, i) => header[i] === byte)) {
        return type;
      }
    }

    const tarHeader = new Uint8Array(await file.slice(257, 262).arrayBuffer());
    if (USTAR_MAGIC.every((byte, i) => tarHeader[i] === byte)) {
      return "tar";
    }

    return null;
  } catch {
    return null;
  }
}

async function listEntriesRar(filePath: string): Promise<string[]> {
  try {
    const extractor = await createExtractorFromFile({ filepath: filePath });
    const list = extractor.getFileList();
    return [...list.fileHeaders].map((h) => h.name);
  } catch {
    return [];
  }
}

async function listEntriesShell(filePath: string, type: "zip" | "7z" | "tar"): Promise<string[]> {
  const commands: Record<"zip" | "7z" | "tar", string[]> = {
    zip: ["zipinfo", "-1", filePath],
    "7z": ["7zz", "l", "-ba", "-slt", filePath],
    tar: ["tar", "-tf", filePath],
  };

  try {
    const { stdout, exitCode, timedOut } = await spawnWithTimeoutText({ command: commands[type] });
    if (timedOut || exitCode !== 0) return [];

    if (type === "7z") {
      return stdout
        .split("\n")
        .filter((line) => line.startsWith("Path = "))
        .map((line) => line.slice(7))
        .slice(1);
    }

    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0 && !line.endsWith("/"));
  } catch {
    return [];
  }
}

export async function listEntries(filePath: string): Promise<string[]> {
  const type = await detectArchiveType(filePath);
  if (!type) return [];

  if (type === "rar") {
    return listEntriesRar(filePath);
  }
  return listEntriesShell(filePath, type);
}

async function readEntryTar(filePath: string, entryPath: string): Promise<Buffer | null> {
  try {
    const { stdout, exitCode, timedOut } = await spawnWithTimeout({
      command: ["tar", "-xOf", filePath, entryPath],
    });
    if (timedOut || exitCode !== 0 || stdout.byteLength === 0) return null;
    return Buffer.from(stdout);
  } catch {
    return null;
  }
}

async function readEntryRar(filePath: string, entryPath: string): Promise<Buffer | null> {
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "rar-"));
    const extractor = await createExtractorFromFile({
      filepath: filePath,
      targetPath: tempDir,
    });
    const { files } = extractor.extract({ files: [entryPath] });
    const results = [...files];
    const found = results.find((r) => r.fileHeader.name === entryPath);
    if (!found || found.fileHeader.flags.directory) return null;

    return Buffer.from(await readFile(join(tempDir, entryPath)));
  } catch {
    return null;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readEntryShell(filePath: string, entryPath: string, type: "zip" | "7z"): Promise<Buffer | null> {
  const commands: Record<"zip" | "7z", string[]> = {
    zip: ["unzip", "-p", filePath, entryPath],
    "7z": ["7zz", "e", "-so", filePath, entryPath],
  };

  try {
    const { stdout, exitCode, timedOut } = await spawnWithTimeout({ command: commands[type] });
    if (timedOut || exitCode !== 0 || stdout.byteLength === 0) return null;
    return Buffer.from(stdout);
  } catch {
    return null;
  }
}

export async function readEntry(filePath: string, entryPath: string): Promise<Buffer | null> {
  const type = await detectArchiveType(filePath);
  if (!type) return null;

  if (type === "rar") {
    return readEntryRar(filePath, entryPath);
  }
  if (type === "tar") {
    return readEntryTar(filePath, entryPath);
  }
  return readEntryShell(filePath, entryPath, type);
}

export async function readEntryText(filePath: string, entryPath: string): Promise<string | null> {
  const buffer = await readEntry(filePath, entryPath);
  return buffer ? buffer.toString("utf-8") : null;
}
