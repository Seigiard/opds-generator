import { Effect, Semaphore } from "effect";
import { createExtractorFromFile } from "node-unrar-js";
import { join } from "node:path";
import { detectArchiveType } from "./archive-type.ts";
import { runCommand, runCommandText, useTemporaryDirectory } from "./process.ts";
import { listZipEntries, readZipEntry } from "./zip.ts";

/**
 * File entries of any supported archive, dispatched by magic bytes. Unknown input yields `[]`.
 * An unreadable archive, a command that cannot run, times out or exits nonzero also yield `[]`.
 * Interruption stops running commands and stays interruption.
 */
export function listArchiveEntries(filePath: string): Effect.Effect<string[]> {
  return detectArchiveType(filePath).pipe(
    Effect.flatMap((type) => {
      switch (type) {
        case null:
          return Effect.succeed([]);
        case "zip":
          return listZipEntries(filePath);
        case "rar":
          return listRarEntries(filePath);
        case "7z":
          return listCommandEntries(["7zz", "l", "-ba", "-slt", filePath], parse7zListing);
        case "tar":
          return listCommandEntries(["tar", "-tf", filePath], parseTarListing);
      }
    }),
  );
}

/** One entry's bytes from any supported archive, or `null`; dispatched and recovered like `listArchiveEntries`. */
export function readArchiveEntry(filePath: string, entryPath: string): Effect.Effect<Buffer | null> {
  return detectArchiveType(filePath).pipe(
    Effect.flatMap((type) => {
      switch (type) {
        case null:
          return Effect.succeed(null);
        case "zip":
          return readZipEntry(filePath, entryPath);
        case "rar":
          return readRarEntry(filePath, entryPath);
        case "7z":
          return readCommandEntry(["7zz", "e", "-so", filePath, entryPath]);
        case "tar":
          return readCommandEntry(["tar", "-xOf", filePath, entryPath]);
      }
    }),
  );
}

export function readArchiveEntryText(filePath: string, entryPath: string): Effect.Effect<string | null> {
  return readArchiveEntry(filePath, entryPath).pipe(Effect.map((buffer) => (buffer ? buffer.toString("utf-8") : null)));
}

function listCommandEntries(command: string[], parse: (stdout: string) => string[]): Effect.Effect<string[]> {
  return runCommandText({ command }).pipe(
    Effect.map(({ stdout, exitCode, timedOut }) => (timedOut || exitCode !== 0 ? [] : parse(stdout))),
    Effect.catchTag("CommandFailed", () => Effect.succeed([])),
  );
}

function readCommandEntry(command: string[]): Effect.Effect<Buffer | null> {
  return runCommand({ command }).pipe(
    Effect.map(({ stdout, exitCode, timedOut }) => (timedOut || exitCode !== 0 || stdout.byteLength === 0 ? null : Buffer.from(stdout))),
    Effect.catchTag("CommandFailed", () => Effect.succeed(null)),
  );
}

// `-ba` omits the archive's own block, so every `Path = ` line names an entry.
function parse7zListing(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("Path = "))
    .map((line) => line.slice(7));
}

function parseTarListing(stdout: string): string[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0 && !line.endsWith("/"));
}

// node-unrar-js routes every extractor's file callbacks through one shared WASM instance (`unrar.extractor`),
// so overlapping RAR operations could write into each other's directories. They run one at a time.
const rarLock = Semaphore.makeUnsafe(1);

/** WASM extraction and file reads cannot be stopped midway: they finish, then interruption takes effect. */
function runNative<A>(work: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: work, catch: (cause) => cause }).pipe(Effect.uninterruptible);
}

function listRarEntries(filePath: string): Effect.Effect<string[]> {
  return runNative(async () => {
    const extractor = await createExtractorFromFile({ filepath: filePath });

    return Array.from(extractor.getFileList().fileHeaders, (header) => header.name);
  }).pipe(
    Semaphore.withPermit(rarLock),
    Effect.orElseSucceed((): string[] => []),
  );
}

/** Extracts the entry into a temporary directory and reads it there; the directory is removed after both finish. */
function readRarEntry(filePath: string, entryPath: string): Effect.Effect<Buffer | null> {
  return useTemporaryDirectory("rar-", (directory) =>
    runNative(async () => {
      const extractor = await createExtractorFromFile({ filepath: filePath, targetPath: directory });
      const { files } = extractor.extract({ files: [entryPath] });
      const found = Array.from(files).find((file) => file.fileHeader.name === entryPath);

      return found !== undefined && !found.fileHeader.flags.directory;
    }).pipe(
      Semaphore.withPermit(rarLock),
      Effect.flatMap((extracted) =>
        extracted ? runNative(async () => Buffer.from(await Bun.file(join(directory, entryPath)).arrayBuffer())) : Effect.succeed(null),
      ),
    ),
  ).pipe(Effect.orElseSucceed(() => null));
}
