import { Effect } from "effect";
import { detectArchiveType } from "./archive-type.ts";
import { runCommand, runCommandText } from "./process.ts";

/**
 * File entries of a ZIP archive, directories excluded. Input that is not a ZIP archive, a command that
 * cannot run, times out or exits nonzero all yield `[]`. Interruption stops the command and stays interruption.
 */
export function listZipEntries(filePath: string): Effect.Effect<string[]> {
  return whenZip(filePath, [], () =>
    runCommandText({ command: ["zipinfo", "-1", filePath] }).pipe(
      Effect.map(({ stdout, exitCode, timedOut }) =>
        timedOut || exitCode !== 0
          ? []
          : stdout
              .trim()
              .split("\n")
              .filter((line) => line.length > 0 && !line.endsWith("/")),
      ),
      Effect.catchTag("CommandFailed", () => Effect.succeed([])),
    ),
  );
}

/**
 * One entry's bytes. A missing entry, empty output, input that is not a ZIP archive, a command that cannot
 * run, times out or exits nonzero all yield `null`. Interruption stops the command and stays interruption.
 */
export function readZipEntry(filePath: string, entryPath: string): Effect.Effect<Buffer | null> {
  return whenZip(filePath, null, () =>
    runCommand({ command: ["unzip", "-p", filePath, entryPath] }).pipe(
      Effect.map(({ stdout, exitCode, timedOut }) => (timedOut || exitCode !== 0 || stdout.byteLength === 0 ? null : Buffer.from(stdout))),
      Effect.catchTag("CommandFailed", () => Effect.succeed(null)),
    ),
  );
}

export function readZipEntryText(filePath: string, entryPath: string): Effect.Effect<string | null> {
  return readZipEntry(filePath, entryPath).pipe(Effect.map((buffer) => (buffer ? buffer.toString("utf-8") : null)));
}

function whenZip<A>(filePath: string, otherwise: A, read: () => Effect.Effect<A>): Effect.Effect<A> {
  return detectArchiveType(filePath).pipe(Effect.flatMap((type) => (type === "zip" ? read() : Effect.succeed(otherwise))));
}
