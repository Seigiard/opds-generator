import { Effect } from "effect";
import { createExtractorFromFile } from "node-unrar-js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectArchiveType } from "./archive-type.ts";
import { ownedPromise } from "./owned-promise.ts";
import { runOwned, spawnWithTimeout, spawnWithTimeoutText, withTemporaryDirectory } from "./process.ts";
import { listZipEntries, readZipEntry } from "./zip.ts";

/**
 * File entries of any supported archive, dispatched by magic bytes. Unknown input yields `[]`.
 * ZIP runs natively in `zip.ts`; RAR, 7z and TAR cross the temporary legacy bridge until they move (#46).
 */
export function listArchiveEntries(filePath: string): Effect.Effect<string[]> {
  return detectArchiveType(filePath).pipe(
    Effect.flatMap((type) => {
      if (type === null) return Effect.succeed([]);

      if (type === "zip") return listZipEntries(filePath);

      return legacyVariant([], (signal) => (type === "rar" ? listEntriesRar(filePath, signal) : listEntriesShell(filePath, type, signal)));
    }),
  );
}

/** One entry's bytes from any supported archive, or `null`; dispatched like `listArchiveEntries`. */
export function readArchiveEntry(filePath: string, entryPath: string): Effect.Effect<Buffer | null> {
  return detectArchiveType(filePath).pipe(
    Effect.flatMap((type) => {
      if (type === null) return Effect.succeed(null);

      if (type === "zip") return readZipEntry(filePath, entryPath);

      return legacyVariant(null, (signal) => {
        if (type === "rar") return readEntryRar(filePath, entryPath, signal);

        return type === "tar" ? readEntryTar(filePath, entryPath, signal) : readEntry7z(filePath, entryPath, signal);
      });
    }),
  );
}

export function readArchiveEntryText(filePath: string, entryPath: string): Effect.Effect<string | null> {
  return readArchiveEntry(filePath, entryPath).pipe(Effect.map((buffer) => (buffer ? buffer.toString("utf-8") : null)));
}

/**
 * Temporary bridge to the Promise RAR/7z/TAR helpers (#46). They recover ordinary failures themselves and reject only
 * when `signal` aborts; `ownedPromise` aborts it on interruption and waits for the helper to settle.
 */
function legacyVariant<A>(fallback: A, run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A> {
  return ownedPromise(run, (cause) => cause).pipe(Effect.orElseSucceed(() => fallback));
}

// Temporary Promise wrappers for legacy comic and FB2 callers (#40), over the Effect dispatch above.

export function listEntries(filePath: string, signal?: AbortSignal): Promise<string[]> {
  return runOwned(listArchiveEntries(filePath), signal);
}

export function readEntry(filePath: string, entryPath: string, signal?: AbortSignal): Promise<Buffer | null> {
  return runOwned(readArchiveEntry(filePath, entryPath), signal);
}

export function readEntryText(filePath: string, entryPath: string, signal?: AbortSignal): Promise<string | null> {
  return runOwned(readArchiveEntryText(filePath, entryPath), signal);
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
