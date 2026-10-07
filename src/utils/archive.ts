import { createExtractorFromFile } from "node-unrar-js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectArchiveType } from "./archive-type.ts";
import { runOwned, spawnWithTimeout, spawnWithTimeoutText, withTemporaryDirectory } from "./process.ts";
import { listZipEntries, readZipEntry } from "./zip.ts";

// Temporary Promise wrappers for legacy comic and FB2 callers (#40). ZIP runs the shared Effect operations in
// `zip.ts`; RAR, 7z and TAR keep their Promise paths until #46.

async function listEntriesRar(filePath: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const extractor = await createExtractorFromFile({ filepath: filePath });
    signal?.throwIfAborted();
    const list = extractor.getFileList();

    return [...list.fileHeaders].map((h) => h.name);
  } catch {
    signal?.throwIfAborted();

    return [];
  }
}

async function listEntriesShell(filePath: string, type: "7z" | "tar", signal?: AbortSignal): Promise<string[]> {
  const commands: Record<"7z" | "tar", string[]> = {
    "7z": ["7zz", "l", "-ba", "-slt", filePath],
    tar: ["tar", "-tf", filePath],
  };

  try {
    const { stdout, exitCode, timedOut } = await spawnWithTimeoutText({ command: commands[type], signal });

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
    signal?.throwIfAborted();

    return [];
  }
}

export async function listEntries(filePath: string, signal?: AbortSignal): Promise<string[]> {
  const type = await runOwned(detectArchiveType(filePath), signal);

  if (!type) return [];

  if (type === "zip") return runOwned(listZipEntries(filePath), signal);

  if (type === "rar") {
    return listEntriesRar(filePath, signal);
  }

  return listEntriesShell(filePath, type, signal);
}

async function readEntryTar(filePath: string, entryPath: string, signal?: AbortSignal): Promise<Buffer | null> {
  try {
    const { stdout, exitCode, timedOut } = await spawnWithTimeout({
      command: ["tar", "-xOf", filePath, entryPath],
      signal,
    });

    if (timedOut || exitCode !== 0 || stdout.byteLength === 0) return null;

    return Buffer.from(stdout);
  } catch {
    signal?.throwIfAborted();

    return null;
  }
}

async function readEntryRar(filePath: string, entryPath: string, signal?: AbortSignal): Promise<Buffer | null> {
  try {
    return await withTemporaryDirectory(
      "rar-",
      async (tempDir) => {
        signal?.throwIfAborted();

        const extractor = await createExtractorFromFile({
          filepath: filePath,
          targetPath: tempDir,
        });

        signal?.throwIfAborted();

        const { files } = extractor.extract({ files: [entryPath] });
        const results = [...files];
        const found = results.find((r) => r.fileHeader.name === entryPath);

        if (!found || found.fileHeader.flags.directory) return null;

        const data = Buffer.from(await readFile(join(tempDir, entryPath)));
        signal?.throwIfAborted();

        return data;
      },
      signal,
    );
  } catch {
    signal?.throwIfAborted();

    return null;
  }
}

async function readEntry7z(filePath: string, entryPath: string, signal?: AbortSignal): Promise<Buffer | null> {
  try {
    const { stdout, exitCode, timedOut } = await spawnWithTimeout({ command: ["7zz", "e", "-so", filePath, entryPath], signal });

    if (timedOut || exitCode !== 0 || stdout.byteLength === 0) return null;

    return Buffer.from(stdout);
  } catch {
    signal?.throwIfAborted();

    return null;
  }
}

export async function readEntry(filePath: string, entryPath: string, signal?: AbortSignal): Promise<Buffer | null> {
  const type = await runOwned(detectArchiveType(filePath), signal);

  if (!type) return null;

  if (type === "zip") return runOwned(readZipEntry(filePath, entryPath), signal);

  if (type === "rar") {
    return readEntryRar(filePath, entryPath, signal);
  }

  if (type === "tar") {
    return readEntryTar(filePath, entryPath, signal);
  }

  return readEntry7z(filePath, entryPath, signal);
}

export async function readEntryText(filePath: string, entryPath: string, signal?: AbortSignal): Promise<string | null> {
  const buffer = await readEntry(filePath, entryPath, signal);

  return buffer ? buffer.toString("utf-8") : null;
}
