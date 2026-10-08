import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as unrar from "node-unrar-js";
import { listArchiveEntries, readArchiveEntry, readArchiveEntryText } from "../../../src/utils/archive.ts";
import { installHangingCommands, isAlive, waitForHangingChild, type HangingChild } from "../../helpers/hanging-command.ts";
import { FIXTURES_DIR, SAMPLE_IMAGE_SHA256, SAMPLE_IMAGES, buildComic, sampleImage, sha256 } from "../../helpers/comic-archives.ts";

const CBR = join(FIXTURES_DIR, "bobby_make_believe_sample.cbr");

const CB7 = join(FIXTURES_DIR, "bobby_make_believe_sample.cb7");

const CBT = join(FIXTURES_DIR, "bobby_make_believe_sample.cbt");

const CBZ = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");

const TEXT_FILE = join(FIXTURES_DIR, "sample_text.txt");

// An entry name a book could carry that a command would read as an option.
const OPTION_LIKE_ENTRY = "--to-command=touch /tmp/opds-injected";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  return dir;
}

async function hang(names: string[], intercept?: (command: readonly string[]) => boolean): Promise<(name: string) => string> {
  const root = await tempDir("archive-hang-");
  const { ready, restore } = await installHangingCommands(names, root, intercept);
  cleanups.push(async () => restore());

  return ready;
}

function failSpawnOf(name: string): void {
  const originalSpawn = Bun.spawn.bind(Bun);

  // SAFETY: the spy forwards Bun.spawn's own arguments for every other command.
  const spy = spyOn(Bun, "spawn").mockImplementation((command: any, options?: any) => {
    if (command[0] === name) throw new Error(`${name} missing`);

    return originalSpawn(command, options);
  });

  cleanups.push(async () => spy.mockRestore());
}

function recordSpawns(): string[][] {
  const originalSpawn = Bun.spawn.bind(Bun);
  const commands: string[][] = [];

  // SAFETY: the spy forwards Bun.spawn's own arguments unchanged.
  const spy = spyOn(Bun, "spawn").mockImplementation((command: any, options?: any) => {
    commands.push(command);

    return originalSpawn(command, options);
  });

  cleanups.push(async () => spy.mockRestore());

  return commands;
}

function exitKind<A>(exit: Exit.Exit<A>): "interrupted" | "completed" {
  return Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "completed";
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
    exit: exitKind(exit),
    childAlive: isAlive(child.pid),
    outputDirectoryExists: await stat(dirname(child.output)).then(
      () => true,
      () => false,
    ),
  };
}

/** A file whose magic bytes name the archive type and whose body is not a valid archive. */
async function corrupted(magic: readonly number[]): Promise<string> {
  const dir = await tempDir("archive-corrupt-");
  const path = join(dir, "corrupt.bin");
  await Bun.write(path, Buffer.concat([Buffer.from(magic), Buffer.alloc(600, 0x41)]));

  return path;
}

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

describe("listArchiveEntries", () => {
  test.each([
    { type: "RAR", path: CBR },
    { type: "7z", path: CB7 },
    { type: "TAR", path: CBT },
    { type: "ZIP", path: CBZ },
  ])("lists the page images of the $type sample", async ({ path }) => {
    // #given / #when
    const entries = await run(listArchiveEntries(path));
    // #then
    expect(entries).toEqual(SAMPLE_IMAGES);
  });

  test("lists the nested page images of the TAR sample with directories", async () => {
    // #given / #when
    const entries = await run(listArchiveEntries(join(FIXTURES_DIR, "bobby_make_believe_sample_dir.cbt")));
    // #then
    expect(entries).toEqual(SAMPLE_IMAGES.map((image) => `images/bobby_make_believe/${image}`));
  });

  test("drops TAR directory entries but keeps 7z directory entries", async () => {
    // #given archives holding a directory with one file
    const dir = await tempDir("archive-dirs-");
    const files = { "pages/": "", "pages/one.txt": "one" };
    const sevenZip = await buildComic(dir, "dirs.cb7", "cb7", files);
    const tar = await buildComic(dir, "dirs.cbt", "cbt", files);

    // #when
    const listings = { sevenZip: await run(listArchiveEntries(sevenZip)), tar: await run(listArchiveEntries(tar)) };

    // #then
    expect(listings).toEqual({ sevenZip: ["pages", "pages/one.txt"], tar: ["pages/one.txt"] });
  });

  test.each([
    { name: "a missing file", path: "/non/existent/file.cbr" },
    { name: "a file that is no archive", path: TEXT_FILE },
  ])("returns no entries for $name", async ({ path }) => {
    // #given / #when
    const entries = await run(listArchiveEntries(path));
    // #then
    expect(entries).toEqual([]);
  });

  test.each([
    { type: "RAR", magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00] },
    { type: "7z", magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  ])("returns no entries for a corrupted $type archive", async ({ magic }) => {
    // #given
    const path = await corrupted(magic);
    // #when
    const entries = await run(listArchiveEntries(path));
    // #then
    expect(entries).toEqual([]);
  });

  test.each([
    { command: "7zz", path: CB7 },
    { command: "tar", path: CBT },
  ])("returns no entries when $command cannot start", async ({ command, path }) => {
    // #given
    failSpawnOf(command);
    // #when
    const entries = await run(listArchiveEntries(path));
    // #then
    expect(entries).toEqual([]);
  });

  test.each([
    { command: "7zz", path: CB7 },
    { command: "tar", path: CBT },
  ])(
    "interruption of a $command listing stays interruption and kills the command",
    async ({ command, path }) => {
      // #given a listing command that runs until killed
      const ready = await hang([command]);
      // #when
      const outcome = await interruptWhileRunning(listArchiveEntries(path), ready(command));
      // #then
      expect(outcome).toEqual({ exit: "interrupted", childAlive: false, outputDirectoryExists: false });
    },
    15_000,
  );
});

describe("readArchiveEntry", () => {
  test.each([
    { type: "RAR", path: CBR },
    { type: "7z", path: CB7 },
    { type: "TAR", path: CBT },
    { type: "ZIP", path: CBZ },
  ])("reads a page image from the $type sample", async ({ path }) => {
    // #given / #when
    const data = await run(readArchiveEntry(path, SAMPLE_IMAGES[1]!));
    // #then
    expect(sha256(data)).toBe(SAMPLE_IMAGE_SHA256[1]);
  });

  test.each([
    { type: "RAR", path: CBR },
    { type: "7z", path: CB7 },
    { type: "TAR", path: CBT },
  ])("returns null for a missing $type entry", async ({ path }) => {
    // #given / #when
    const data = await run(readArchiveEntry(path, "missing.jpg"));
    // #then
    expect(data).toBeNull();
  });

  test.each([
    { type: "7z", path: CB7 },
    { type: "TAR", path: CBT },
    { type: "ZIP", path: CBZ },
  ])("an option-like $type entry path reads as missing and never reaches a command", async ({ path }) => {
    // #given
    const commands = recordSpawns();
    // #when
    const data = await run(readArchiveEntry(path, OPTION_LIKE_ENTRY));
    // #then
    expect({ data, injected: commands.flat().filter((arg) => arg === OPTION_LIKE_ENTRY) }).toEqual({ data: null, injected: [] });
  });

  test.each(["cb7", "cbt"] as const)("returns null for a %s directory entry and for an empty file", async (type) => {
    // #given an archive with a directory and an empty file next to a real one
    const dir = await tempDir("archive-read-");
    const archive = await buildComic(dir, `entries.${type}`, type, { "pages/": "", "empty.txt": "", "page.jpg": await sampleImage(2) });

    // #when
    const reads = {
      directory: await run(readArchiveEntry(archive, "pages")),
      empty: await run(readArchiveEntry(archive, "empty.txt")),
      page: sha256(await run(readArchiveEntry(archive, "page.jpg"))),
    };

    // #then
    expect(reads).toEqual({ directory: null, empty: null, page: SAMPLE_IMAGE_SHA256[2] });
  });

  test.each([
    { name: "a missing file", path: "/non/existent/file.cb7" },
    { name: "a file that is no archive", path: TEXT_FILE },
  ])("returns null for $name", async ({ path }) => {
    // #given / #when
    const data = await run(readArchiveEntry(path, SAMPLE_IMAGES[0]!));
    // #then
    expect(data).toBeNull();
  });

  test.each([
    { type: "RAR", magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00] },
    { type: "7z", magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  ])("returns null for a corrupted $type archive", async ({ magic }) => {
    // #given
    const path = await corrupted(magic);
    // #when
    const data = await run(readArchiveEntry(path, SAMPLE_IMAGES[0]!));
    // #then
    expect(data).toBeNull();
  });

  test.each([
    { command: "7zz", path: CB7 },
    { command: "tar", path: CBT },
  ])("returns null when $command cannot start", async ({ command, path }) => {
    // #given
    failSpawnOf(command);
    // #when
    const data = await run(readArchiveEntry(path, SAMPLE_IMAGES[0]!));
    // #then
    expect(data).toBeNull();
  });

  test.each([
    { command: "7zz", path: CB7 },
    { command: "tar", path: CBT },
  ])(
    "interruption of a $command read stays interruption and kills the command",
    async ({ command, path }) => {
      // #given a read command that runs until killed
      const ready = await hang([command]);
      // #when
      const outcome = await interruptWhileRunning(readArchiveEntry(path, SAMPLE_IMAGES[0]!), ready(command));
      // #then
      expect(outcome).toEqual({ exit: "interrupted", childAlive: false, outputDirectoryExists: false });
    },
    15_000,
  );
});

describe("RAR entry reads through a temporary directory", () => {
  /** Holds `Bun.file(<rar temporary directory>/<entry>).arrayBuffer()` until `release()`. */
  function holdExtractedRead(entry: string) {
    const originalFile = Bun.file.bind(Bun);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<string>();

    // SAFETY: the mock takes the string-path overload the RAR read calls and returns the real BunFile for it.
    const fileSpy = spyOn(Bun, "file").mockImplementation(((target: string, options?: BlobPropertyBag) => {
      const file = originalFile(target, options);

      if (!(target.includes("/rar-") && target.endsWith(`/${entry}`))) return file;

      const arrayBuffer = file.arrayBuffer.bind(file);
      file.arrayBuffer = () => {
        markStarted(target);

        return gate.then(arrayBuffer);
      };

      return file;
    }) as typeof Bun.file);

    cleanups.push(async () => {
      release();
      fileSpy.mockRestore();
    });

    return { started, release: () => release(), readUnheld: (path: string) => originalFile(path).arrayBuffer() };
  }

  test("interruption waits for the read of the extracted file, then removes the directory and stays interruption", async () => {
    // #given a RAR read held after native extraction, while it reads the extracted file
    const held = holdExtractedRead(SAMPLE_IMAGES[1]!);
    const controller = new AbortController();
    const task = Effect.runPromiseExit(readArchiveEntry(CBR, SAMPLE_IMAGES[1]!), { signal: controller.signal });
    const extracted = await held.started;

    // #when interruption arrives during the read
    controller.abort();
    const beforeRelease = await Promise.race([task.then(() => "settled"), Bun.sleep(100).then(() => "waiting")]);
    const extractedDuringRead = sha256(Buffer.from(await held.readUnheld(extracted)));
    held.release();
    const exit = await task;

    // #then the extracted file stayed available until the read finished, then its directory was removed
    expect({
      beforeRelease,
      extractedDuringRead,
      exit: exitKind(exit),
      directoryExists: await stat(dirname(extracted)).then(
        () => true,
        () => false,
      ),
    }).toEqual({ beforeRelease: "waiting", extractedDuringRead: SAMPLE_IMAGE_SHA256[1], exit: "interrupted", directoryExists: false });
  });

  test("a completed read leaves no temporary directory behind", async () => {
    // #given
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("rar-"));
    // #when
    await run(readArchiveEntry(CBR, SAMPLE_IMAGES[0]!));
    // #then
    expect((await readdir(tmpdir())).filter((name) => name.startsWith("rar-"))).toEqual(before);
  });

  test("reads whose extractors are created together each return their own entry", async () => {
    // #given node-unrar-js keeps the last created extractor on its one shared WASM instance. Warm that instance,
    // then hold each created extractor until a second one exists, or until 300 ms pass when none can be created.
    await run(readArchiveEntry(CBR, SAMPLE_IMAGES[3]!));
    const createExtractor = unrar.createExtractorFromFile;
    const bothCreated = Promise.withResolvers<void>();
    let created = 0;

    const spy = spyOn(unrar, "createExtractorFromFile").mockImplementation(async (options) => {
      const extractor = await createExtractor(options);

      if (++created === 2) bothCreated.resolve();
      await Promise.race([bothCreated.promise, Bun.sleep(300)]);

      return extractor;
    });

    cleanups.push(async () => spy.mockRestore());

    // #when two pages are read at the same time
    const pages = await run(
      Effect.all([readArchiveEntry(CBR, SAMPLE_IMAGES[0]!), readArchiveEntry(CBR, SAMPLE_IMAGES[1]!)], { concurrency: "unbounded" }),
    );

    // #then
    expect(pages.map(sha256)).toEqual([SAMPLE_IMAGE_SHA256[0], SAMPLE_IMAGE_SHA256[1]]);
  });
});

describe("Archive command timeouts", () => {
  test("7z and TAR listings and reads that time out yield no entries and no data", async () => {
    // #given listing and read commands that run until the 15 s command timeout kills them
    await hang(["7zz", "tar"]);

    // #when
    const outcome = await run(
      Effect.all(
        [
          listArchiveEntries(CB7),
          readArchiveEntry(CB7, SAMPLE_IMAGES[0]!),
          listArchiveEntries(CBT),
          readArchiveEntry(CBT, SAMPLE_IMAGES[0]!),
        ],
        { concurrency: "unbounded" },
      ),
    );

    // #then
    expect(outcome).toEqual([[], null, [], null]);
  }, 25_000);
});

describe("readArchiveEntryText", () => {
  test("decodes a text entry of a zipped FB2", async () => {
    // #given / #when
    const text = await run(readArchiveEntryText(join(FIXTURES_DIR, "Test Book - Test Author.fb2.zip"), "Test Book - Test Author.fb2"));
    // #then
    expect(text?.slice(0, 38)).toBe('<?xml version="1.0" encoding="UTF-8"?>');
  });

  test("returns null for a missing entry", async () => {
    // #given / #when
    const text = await run(readArchiveEntryText(CBT, "missing.txt"));
    // #then
    expect(text).toBeNull();
  });
});
