import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listZipEntries, readZipEntry } from "../../../src/utils/zip.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { installHangingCommands, isAlive, waitForHangingChild, type HangingChild } from "../../helpers/hanging-command.ts";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const EPUB = join(FIXTURES_DIR, "Test Book - Test Author.epub");

const TEXT_FILE = join(FIXTURES_DIR, "sample_text.txt");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function failSpawnOf(name: string): void {
  const originalSpawn = Bun.spawn.bind(Bun);

  // SAFETY: the spy forwards Bun.spawn's own arguments for every other command.
  const spy = spyOn(Bun, "spawn").mockImplementation((command: any, options?: any) => {
    if (command[0] === name) throw new Error(`${name} missing`);

    return originalSpawn(command, options);
  });

  cleanups.push(async () => spy.mockRestore());
}

async function hang(...names: string[]): Promise<(name: string) => string> {
  const root = await mkdtemp(join(tmpdir(), "zip-hang-"));
  const { ready, restore } = await installHangingCommands(names, root);
  cleanups.push(async () => {
    restore();
    await rm(root, { recursive: true, force: true });
  });

  return ready;
}

async function interruptWhileRunning<A>(effect: Effect.Effect<A>, ready: string) {
  const controller = new AbortController();
  const task = Effect.runPromiseExit(effect, { signal: controller.signal });
  const child: HangingChild = await waitForHangingChild(ready);
  cleanups.push(async () => {
    if (isAlive(child.pid)) process.kill(child.pid, "SIGKILL");
  });

  controller.abort();
  const exit = await task;

  return {
    exit: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "completed",
    childAlive: isAlive(child.pid),
    outputDirectoryExists: await stat(dirname(child.output)).then(
      () => true,
      () => false,
    ),
  };
}

describe("listZipEntries", () => {
  test("lists the file entries of a ZIP archive without directories", async () => {
    // #given a known EPUB archive
    // #when
    const entries = await Effect.runPromise(listZipEntries(EPUB));
    // #then
    expect(entries).toEqual([
      "mimetype",
      "META-INF/container.xml",
      "page_styles.css",
      "titlepage.xhtml",
      "stylesheet.css",
      "content.opf",
      "cover.jpeg",
      "toc.ncx",
      "EPUB/nav.xhtml",
      "EPUB/text/ch001.xhtml",
      "EPUB/text/title_page.xhtml",
    ]);
  });

  test("returns no entries for a file that is not a ZIP archive", async () => {
    // #given / #when
    const entries = await Effect.runPromise(listZipEntries(TEXT_FILE));
    // #then
    expect(entries).toEqual([]);
  });

  test("returns no entries for a missing file", async () => {
    // #given / #when
    const entries = await Effect.runPromise(listZipEntries("/non/existent/file.zip"));
    // #then
    expect(entries).toEqual([]);
  });

  test("returns no entries when the listing command cannot start", async () => {
    // #given
    failSpawnOf("zipinfo");
    // #when
    const entries = await Effect.runPromise(listZipEntries(EPUB));
    // #then
    expect(entries).toEqual([]);
  });

  test("interruption stays interruption, kills the listing command and releases its output", async () => {
    // #given a listing command that runs until killed
    const ready = await hang("zipinfo");
    // #when
    const outcome = await interruptWhileRunning(listZipEntries(EPUB), ready("zipinfo"));
    // #then
    expect(outcome).toEqual({ exit: "interrupted", childAlive: false, outputDirectoryExists: false });
  }, 15_000);
});

describe("readZipEntry", () => {
  test("reads a text entry", async () => {
    // #given / #when
    const data = await Effect.runPromise(readZipEntry(EPUB, "mimetype"));
    // #then
    expect(data?.toString("utf-8")).toBe("application/epub+zip");
  });

  test("reads a binary entry", async () => {
    // #given / #when
    const cover = await Effect.runPromise(readZipEntry(EPUB, "cover.jpeg"));
    // #then
    await assertCoverMatchesReference(cover!);
  });

  test("returns null for a missing entry", async () => {
    // #given / #when
    const data = await Effect.runPromise(readZipEntry(EPUB, "missing.jpeg"));
    // #then
    expect(data).toBeNull();
  });

  test("returns null for a directory entry, whose output is empty", async () => {
    // #given / #when
    const data = await Effect.runPromise(readZipEntry(EPUB, "META-INF/"));
    // #then
    expect(data).toBeNull();
  });

  test("returns null for a file that is not a ZIP archive", async () => {
    // #given / #when
    const data = await Effect.runPromise(readZipEntry(TEXT_FILE, "anything"));
    // #then
    expect(data).toBeNull();
  });

  test("returns null when the read command cannot start", async () => {
    // #given
    failSpawnOf("unzip");
    // #when
    const data = await Effect.runPromise(readZipEntry(EPUB, "mimetype"));
    // #then
    expect(data).toBeNull();
  });

  test("interruption stays interruption, kills the read command and releases its output", async () => {
    // #given a read command that runs until killed
    const ready = await hang("unzip");
    // #when
    const outcome = await interruptWhileRunning(readZipEntry(EPUB, "mimetype"), ready("unzip"));
    // #then
    expect(outcome).toEqual({ exit: "interrupted", childAlive: false, outputDirectoryExists: false });
  }, 15_000);
});

describe("ZIP command timeouts", () => {
  test("a listing or read that times out yields no entries and no data", async () => {
    // #given listing and read commands that run until the 15 s command timeout kills them
    await hang("zipinfo", "unzip");
    // #when
    const [entries, data] = await Promise.all([Effect.runPromise(listZipEntries(EPUB)), Effect.runPromise(readZipEntry(EPUB, "mimetype"))]);
    // #then
    expect({ entries, data }).toEqual({ entries: [], data: null });
  }, 25_000);
});
