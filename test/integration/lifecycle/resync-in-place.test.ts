/**
 * The real lifecycle, disk scanner and handlers on a temporary filesystem (issue #15 checks 1, 3 and 6).
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { copyFile, mkdir, readdir, readFile, rm, stat, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandlerDeps } from "../../../src/context.ts";
import { createLifecycle, systemClock } from "../../../src/lifecycle/lifecycle.ts";
import { createDiskScanner } from "../../../src/lifecycle/disk-scanner.ts";
import { createCatalogueProcessor } from "../../../src/processing/catalogue-processor.ts";
import { bookSync } from "../../../src/processing/handlers/book-sync.ts";
import { bookCleanup } from "../../../src/processing/handlers/book-cleanup.ts";
import { folderSync } from "../../../src/processing/handlers/folder-sync.ts";
import { folderCleanup } from "../../../src/processing/handlers/folder-cleanup.ts";
import { folderMetaSync } from "../../../src/processing/handlers/folder-meta-sync.ts";

const TEST_DIR = join(tmpdir(), `opds-resync-in-place-${Date.now()}`);

const FILES_DIR = join(TEST_DIR, "files");

const DATA_DIR = join(TEST_DIR, "data");

const EPUB = "Test Book - Test Author.epub";

const FIXTURE = join(import.meta.dir, "../../../files/test", EPUB);

const deps: HandlerDeps = {
  config: { filesPath: FILES_DIR, dataPath: DATA_DIR, port: 3000, reconcileInterval: 0 },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fs: {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    rm: (path, options) => rm(path, options),
    readdir: (path) => readdir(path),
    stat: async (path) => {
      const s = await stat(path);

      return { isDirectory: () => s.isDirectory(), size: s.size };
    },
    exists: async (path) =>
      stat(path)
        .then(() => true)
        .catch(() => false),
    writeFile: async (path, content) => {
      await Bun.write(path, content);
    },
    atomicWrite: async (path, content) => {
      await Bun.write(path, content);
    },
    symlink: (target, path) => symlink(target, path),
    unlink: (path) => unlink(path),
  },
};

function start() {
  const processor = createCatalogueProcessor({
    deps,
    handlers: {
      BookCreated: bookSync,
      BookDeleted: bookCleanup,
      FolderCreated: folderSync,
      FolderDeleted: folderCleanup,
      FolderMetaSyncRequested: folderMetaSync,
    },
  });

  const lifecycle = createLifecycle({
    scanner: createDiskScanner({ filesPath: FILES_DIR, dataPath: DATA_DIR }),
    processor,
    clock: systemClock,
    reconcileIntervalSeconds: 0,
  });

  lifecycle.start();

  return { lifecycle, processor };
}

async function untilSettled(lifecycle: ReturnType<typeof start>["lifecycle"], probe?: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 20_000;
  // Let the scan start before the first look, so "settled" is not the state from before the request.
  await Bun.sleep(20);

  while (lifecycle.status().state !== "settled") {
    if (Date.now() > deadline) throw new Error(`not settled: ${JSON.stringify(lifecycle.status())}`);
    await probe?.();
    await Bun.sleep(5);
  }
}

const exists = (path: string) =>
  stat(path)
    .then(() => true)
    .catch(() => false);

const rootFeed = () => readFile(join(DATA_DIR, "feed.xml"), "utf8");

describe("Resync repairs the catalogue in place", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(FILES_DIR, "Fiction"), { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });
    await copyFile(FIXTURE, join(FILES_DIR, "Fiction", EPUB));
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("a book added and then deleted leaves a catalogue that matches the books directory once Settled", async () => {
    // #given an initial scan that built the catalogue with one book
    const { lifecycle } = start();
    await untilSettled(lifecycle);
    const entryPath = join(DATA_DIR, "Fiction", EPUB, "entry.xml");
    const added = await exists(entryPath);
    // #when the book is deleted and a resync runs
    await rm(join(FILES_DIR, "Fiction", EPUB));
    lifecycle.requestScan({ kind: "resync", force: false });
    await untilSettled(lifecycle);
    await lifecycle.stop();
    // #then its entry and its mention in the feeds are gone
    expect({
      added,
      entry: await exists(join(DATA_DIR, "Fiction", EPUB)),
      folderFeed: (await readFile(join(DATA_DIR, "Fiction", "feed.xml"), "utf8")).includes("Test Book"),
    }).toEqual({ added: true, entry: false, folderFeed: false });
  });

  test("a forced resync removes nothing from the data directory, so the root feed never disappears", async () => {
    // #given a settled catalogue
    const { lifecycle } = start();
    await untilSettled(lifecycle);
    const sentinel = join(DATA_DIR, "kept-by-resync.txt");
    await Bun.write(sentinel, "no entry owns this file");
    const missing: number[] = [];
    let probes = 0;

    const probe = async () => {
      probes++;

      if (!(await exists(join(DATA_DIR, "feed.xml")))) missing.push(probes);
    };

    // #when a forced resync reprocesses every book, and feed.xml is probed throughout
    lifecycle.requestScan({ kind: "resync", force: true });
    await untilSettled(lifecycle, probe);
    await lifecycle.stop();
    // #then feed.xml was present at every probe, and the book is still catalogued
    expect({
      missing,
      sentinel: await exists(sentinel),
      bookKept: await exists(join(DATA_DIR, "Fiction", EPUB, "entry.xml")),
      feed: (await rootFeed()).length > 0,
    }).toEqual({
      missing: [],
      sentinel: true,
      bookKept: true,
      feed: true,
    });
  });

  test("a stale BookDeleted for a book that exists in the books directory leaves its entry in place", async () => {
    // #given a settled catalogue and a delete event queued for a book that is still there
    const { lifecycle, processor } = start();
    await untilSettled(lifecycle);
    // #when
    processor.submit({ _tag: "BookDeleted", parent: join(FILES_DIR, "Fiction"), name: EPUB });
    await Bun.sleep(50);
    await untilSettled(lifecycle);
    await lifecycle.stop();
    // #then
    expect(await exists(join(DATA_DIR, "Fiction", EPUB, "entry.xml"))).toBe(true);
  });
});
