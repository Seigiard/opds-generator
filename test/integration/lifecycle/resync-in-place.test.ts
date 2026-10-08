/**
 * The production lifecycle and real handlers on a temporary filesystem (issue #15 checks 1, 3 and 6, now on the shared engine).
 */
import { describe, test, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandlerDeps } from "../../../src/context.ts";
import { buildContext } from "../../../src/context.ts";
import { createLiveEngineLifecycle } from "../../../src/lifecycle/live-engine-lifecycle.ts";

const TEST_DIR = join(tmpdir(), `opds-resync-in-place-${Date.now()}`);

const FILES_DIR = join(TEST_DIR, "files");

const DATA_DIR = join(TEST_DIR, "data");

const EPUB = "Test Book - Test Author.epub";

const FIXTURE = join(import.meta.dir, "../../../files/test", EPUB);

let deps: HandlerDeps;

function start() {
  const lifecycle = createLiveEngineLifecycle(deps);
  void lifecycle.start();

  return { lifecycle };
}

async function untilSettled(lifecycle: ReturnType<typeof start>["lifecycle"], probe?: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 20_000;
  // Let the pass start before the first look, so "completed" is not the state from before the request.
  await Bun.sleep(20);

  while (!(await lifecycle.status()).completed) {
    if (Date.now() > deadline) throw new Error(`not completed: ${JSON.stringify(await lifecycle.status())}`);
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
  beforeAll(async () => {
    const ctx = await buildContext();
    deps = {
      ...ctx,
      config: { ...ctx.config, filesPath: FILES_DIR, dataPath: DATA_DIR, reconcileInterval: 0 },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };
  });

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(FILES_DIR, "Fiction"), { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });
    await copyFile(FIXTURE, join(FILES_DIR, "Fiction", EPUB));
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("a book added and then deleted leaves a catalogue that matches the books directory once completed", async () => {
    // #given an initial scan that built the catalogue with one book
    const { lifecycle } = start();
    await untilSettled(lifecycle);
    const entryPath = join(DATA_DIR, "Fiction", EPUB, "entry.xml");
    const added = await exists(entryPath);
    // #when the book is deleted and a resync runs
    await rm(join(FILES_DIR, "Fiction", EPUB));
    await lifecycle.requestScan({ kind: "resync", force: false });
    await untilSettled(lifecycle);
    await lifecycle.stop();
    // #then its entry and its mention in the feeds are gone
    expect({
      added,
      entry: await exists(join(DATA_DIR, "Fiction", EPUB)),
      folderFeed: (await readFile(join(DATA_DIR, "Fiction", "feed.xml"), "utf8")).includes("Test Book"),
    }).toEqual({ added: true, entry: false, folderFeed: false });
  });

  test("a book and a folder removed while the service was down are gone after the next start, and the root keeps serving", async () => {
    // #given a completed catalogue with two folders, then a graceful stop
    await mkdir(join(FILES_DIR, "Poetry"), { recursive: true });
    await copyFile(FIXTURE, join(FILES_DIR, "Poetry", EPUB));
    const first = start().lifecycle;
    await untilSettled(first);

    const before = {
      book: await exists(join(DATA_DIR, "Fiction", EPUB, "entry.xml")),
      poetry: await exists(join(DATA_DIR, "Poetry", "_entry.xml")),
    };

    await first.stop();
    // #when the source changes while nothing runs, and the service starts again
    await rm(join(FILES_DIR, "Fiction", EPUB));
    await rm(join(FILES_DIR, "Poetry"), { recursive: true });
    const second = start().lifecycle;
    await untilSettled(second);
    await second.stop();
    // #then the orphaned outputs and their mentions are removed
    expect({
      before,
      book: await exists(join(DATA_DIR, "Fiction", EPUB)),
      poetry: await exists(join(DATA_DIR, "Poetry")),
      rootMentionsPoetry: (await rootFeed()).includes("Poetry"),
      fictionMentionsBook: (await readFile(join(DATA_DIR, "Fiction", "feed.xml"), "utf8")).includes("Test Book"),
    }).toEqual({ before: { book: true, poetry: true }, book: false, poetry: false, rootMentionsPoetry: false, fictionMentionsBook: false });
  }, 40_000);

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
    await lifecycle.requestScan({ kind: "resync", force: true });
    await untilSettled(lifecycle, probe);
    const status = await lifecycle.status();
    await lifecycle.stop();
    // #then feed.xml was present at every probe, and the book is still catalogued
    expect({
      missing,
      errors: status.errors,
      sentinel: await exists(sentinel),
      bookKept: await exists(join(DATA_DIR, "Fiction", EPUB, "entry.xml")),
      feed: (await rootFeed()).length > 0,
    }).toEqual({
      missing: [],
      errors: [],
      sentinel: true,
      bookKept: true,
      feed: true,
    });
  });

  test("a stale BookDeleted for a book that exists in the books directory leaves its entry in place", async () => {
    // #given a settled catalogue and a delete event queued for a book that is still there
    const { lifecycle } = start();
    await untilSettled(lifecycle);
    // #when
    await lifecycle.submit({ _tag: "BookDeleted", parent: join(FILES_DIR, "Fiction"), name: EPUB });
    await Bun.sleep(50);
    await untilSettled(lifecycle);
    await lifecycle.stop();
    // #then
    expect(await exists(join(DATA_DIR, "Fiction", EPUB, "entry.xml"))).toBe(true);
  });
});
