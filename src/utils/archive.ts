import { createExtractorFromFile } from "node-unrar-js";
import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { spawnWithTimeout, spawnWithTimeoutText, withTemporaryDirectory } from "./process.ts";

type ArchiveType = "zip" | "rar" | "7z" | "tar";

const MAGIC_BYTES: Record<Exclude<ArchiveType, "tar">, number[]> = {
  zip: [0x50, 0x4b, 0x03, 0x04],
  rar: [0x52, 0x61, 0x72, 0x21],
  "7z": [0x37, 0x7a, 0xbc, 0xaf],
};

const USTAR_MAGIC = [0x75, 0x73, 0x74, 0x61, 0x72]; // "ustar"

async function detectArchiveType(filePath: string): Promise<ArchiveType | null> {
  let fh;

  try {
    fh = await open(filePath, "r");
    const header = new Uint8Array(8);
    await fh.read(header, 0, 8, 0);

    // SAFETY: MAGIC_BYTES declares exactly the three non-tar archive keys above.
    for (const [type, magic] of Object.entries(MAGIC_BYTES) as [Exclude<ArchiveType, "tar">, number[]][]) {
      if (magic.every((byte, i) => header[i] === byte)) {
        return type;
      }
    }

    const tarHeader = new Uint8Array(5);
    await fh.read(tarHeader, 0, 5, 257);

    if (USTAR_MAGIC.every((byte, i) => tarHeader[i] === byte)) {
      return "tar";
    }

    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

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

async function listEntriesShell(filePath: string, type: "zip" | "7z" | "tar", signal?: AbortSignal): Promise<string[]> {
  const commands: Record<"zip" | "7z" | "tar", string[]> = {
    zip: ["zipinfo", "-1", filePath],
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
  signal?.throwIfAborted();
  const type = await detectArchiveType(filePath);
  signal?.throwIfAborted();

  if (!type) return [];

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

async function readEntryShell(filePath: string, entryPath: string, type: "zip" | "7z", signal?: AbortSignal): Promise<Buffer | null> {
  const commands: Record<"zip" | "7z", string[]> = {
    zip: ["unzip", "-p", filePath, entryPath],
    "7z": ["7zz", "e", "-so", filePath, entryPath],
  };

  try {
    const { stdout, exitCode, timedOut } = await spawnWithTimeout({ command: commands[type], signal });

    if (timedOut || exitCode !== 0 || stdout.byteLength === 0) return null;

    return Buffer.from(stdout);
  } catch {
    signal?.throwIfAborted();

    return null;
  }
}

export async function readEntry(filePath: string, entryPath: string, signal?: AbortSignal): Promise<Buffer | null> {
  signal?.throwIfAborted();
  const type = await detectArchiveType(filePath);
  signal?.throwIfAborted();

  if (!type) return null;

  if (type === "rar") {
    return readEntryRar(filePath, entryPath, signal);
  }

  if (type === "tar") {
    return readEntryTar(filePath, entryPath, signal);
  }

  return readEntryShell(filePath, entryPath, type, signal);
}

export async function readEntryText(filePath: string, entryPath: string, signal?: AbortSignal): Promise<string | null> {
  const buffer = await readEntry(filePath, entryPath, signal);

  return buffer ? buffer.toString("utf-8") : null;
}
