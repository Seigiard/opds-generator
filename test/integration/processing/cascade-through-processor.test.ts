/**
 * Cascades through the catalogue processor with the real handlers on a temporary filesystem.
 * No watcher runs: every folder refresh in these tests is a cascade returned by a handler.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { ok } from "neverthrow";
import { createCatalogueProcessor, type Handlers } from "../../../src/processing/catalogue-processor.ts";
import { createEffectCatalogueProcessor } from "../../../src/processing/catalogue-processor-effect.ts";
import { toEffectHandlers } from "../../helpers/effect-variants.ts";
import { bookSync } from "../../../src/processing/handlers/book-sync.ts";
import { bookCleanup } from "../../../src/processing/handlers/book-cleanup.ts";
import { folderSync } from "../../../src/processing/handlers/folder-sync.ts";
import { folderCleanup } from "../../../src/processing/handlers/folder-cleanup.ts";
import { folderMetaSync } from "../../../src/processing/handlers/folder-meta-sync.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/processing/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, symlink, unlink, readdir, readFile, utimes } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `opds-processor-cascade-${Date.now()}`);

const FILES_DIR = join(TEST_DIR, "files");

const DATA_DIR = join(TEST_DIR, "data");

const EPUB = "Test Book - Test Author.epub";

const FIXTURE = join(import.meta.dir, "../../../files/test", EPUB);

const deps: Omit<HandlerDeps, "signal"> = {
  config: { filesPath: FILES_DIR, dataPath: DATA_DIR, port: 3000, reconcileInterval: 1800 },
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

const realHandlers: Handlers = {
  BookCreated: bookSync,
  BookDeleted: bookCleanup,
  FolderCreated: folderSync,
  FolderDeleted: folderCleanup,
  FolderMetaSyncRequested: folderMetaSync,
};

const refresh = (path: string): EventType => ({ _tag: "FolderMetaSyncRequested", path });

function gate() {
  let open = () => {};

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

/** Real folder refresh, recording each path it runs for. */
function recordingRefresh(paths: string[], hold?: () => Promise<void>): Handlers["FolderMetaSyncRequested"] {
  return async (event, handlerDeps) => {
    if (event._tag === "FolderMetaSyncRequested") paths.push(event.path);
    await hold?.();

    return folderMetaSync(event, handlerDeps);
  };
}

async function makeSourceFolders(...folders: string[]): Promise<void> {
  for (const folder of folders) await mkdir(join(FILES_DIR, folder), { recursive: true });
}

const feed = (...segments: string[]): Promise<string> => readFile(join(DATA_DIR, ...segments, "feed.xml"), "utf-8");

const updatedOf = (xml: string): string => /<updated>([^<]+)<\/updated>/.exec(xml)?.[1] ?? "";

async function addBook(folder: string): Promise<void> {
  await Bun.write(join(FILES_DIR, folder, EPUB), await Bun.file(FIXTURE).arrayBuffer());
}

// Issue #25: the effect variant runs the Effect processor with the Effect `bookSync`.
const variants = [
  { name: "plain", create: (handlers: Handlers) => createCatalogueProcessor({ deps, handlers }) },
  { name: "effect", create: (handlers: Handlers) => createEffectCatalogueProcessor({ deps, handlers: toEffectHandlers(handlers) }) },
];

describe.each(variants)("Cascades through the catalogue processor ($name)", ({ create }) => {
  function run(handlers: Handlers = realHandlers) {
    const processor = create(handlers);
    const controller = new AbortController();
    const task = processor.start(controller.signal);

    const idle = (): Promise<void> =>
      new Promise((resolve) => {
        const off = processor.onEmpty(() => {
          off();
          resolve();
        });
      });

    const stop = async () => {
      controller.abort();
      await task;
    };

    return { processor, idle, stop };
  }

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(FILES_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("a folder refresh requested while the same refresh is active runs exactly once more, then the parent once", async () => {
    // #given
    await makeSourceFolders("Fiction");
    const paths: string[] = [];
    const release = gate();
    let first = true;

    const { processor, idle, stop } = run({
      ...realHandlers,
      FolderMetaSyncRequested: recordingRefresh(paths, async () => {
        if (!first) return;
        first = false;
        await release.promise;
      }),
    });

    const done = idle();
    processor.submit(refresh(join(DATA_DIR, "Fiction")));
    await Bun.sleep(20);
    // #when
    processor.submit(refresh(join(DATA_DIR, "Fiction")));
    release.open();
    await done;
    await stop();
    // #then
    expect(paths).toEqual([join(DATA_DIR, "Fiction"), join(DATA_DIR, "Fiction"), DATA_DIR]);
  });

  test("a folder refresh requested while the same refresh is pending adds no work and moves behind later work", async () => {
    // #given
    await makeSourceFolders("Fiction", "Poetry");
    const paths: string[] = [];
    const release = gate();

    const { processor, idle, stop } = run({
      ...realHandlers,
      BookCreated: async () => {
        await release.promise;

        return ok([]);
      },
      FolderMetaSyncRequested: recordingRefresh(paths),
    });

    const done = idle();
    processor.submit({ _tag: "BookCreated", parent: FILES_DIR, name: "blocker.epub" });
    await Bun.sleep(20);
    // #when
    processor.submit(refresh(join(DATA_DIR, "Fiction")));
    processor.submit(refresh(join(DATA_DIR, "Poetry")));
    processor.submit(refresh(join(DATA_DIR, "Fiction")));
    const pending = processor.status().pending;
    release.open();
    await done;
    await stop();
    // #then
    expect({ pending, paths }).toEqual({
      pending: 2,
      paths: [join(DATA_DIR, "Poetry"), join(DATA_DIR, "Fiction"), DATA_DIR],
    });
  });

  test("a book handler that fails yields no cascade and the next work runs", async () => {
    // #given
    await makeSourceFolders("Fiction", "Poetry");
    const paths: string[] = [];
    const { processor, idle, stop } = run({ ...realHandlers, FolderMetaSyncRequested: recordingRefresh(paths) });
    const done = idle();
    // #when
    processor.submit({ _tag: "BookCreated", parent: join(FILES_DIR, "Fiction"), name: "missing.epub" });
    processor.submit(refresh(join(DATA_DIR, "Poetry")));
    await done;
    await stop();
    // #then
    expect(paths).toEqual([join(DATA_DIR, "Poetry"), DATA_DIR]);
  });

  test("a book added to a nested folder refreshes the folders whose summary changed, and stops where it did not", async () => {
    // #given
    await makeSourceFolders("Fiction/SciFi");
    const first = run();
    let done = first.idle();
    first.processor.submit({ _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" });
    first.processor.submit({ _tag: "FolderCreated", parent: join(FILES_DIR, "Fiction"), name: "SciFi" });
    await done;
    const rootBefore = updatedOf(await feed());
    await addBook("Fiction/SciFi");
    await Bun.sleep(5);
    done = first.idle();
    // #when
    first.processor.submit({ _tag: "BookCreated", parent: join(FILES_DIR, "Fiction", "SciFi"), name: EPUB });
    await done;
    await first.stop();
    const [sciFi, fiction, root] = [await feed("Fiction", "SciFi"), await feed("Fiction"), await feed()];
    // #then
    expect({
      sciFiHasBook: sciFi.includes("Test Book"),
      fictionShowsSciFiCount: fiction.includes("📚 1"),
      rootRefreshed: updatedOf(root) !== rootBefore,
      rootListsFiction: root.includes("Fiction"),
    }).toEqual({ sciFiHasBook: true, fictionShowsSciFiCount: true, rootRefreshed: false, rootListsFiction: true });
  });

  test("removing a top-level folder refreshes the root feed", async () => {
    // #given
    await makeSourceFolders("Fiction");
    const { processor, idle, stop } = run();
    let done = idle();
    processor.submit({ _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" });
    await done;
    const before = (await feed()).includes("Fiction");
    await rm(join(FILES_DIR, "Fiction"), { recursive: true });
    done = idle();
    // #when
    processor.submit({ _tag: "FolderDeleted", parent: FILES_DIR, name: "Fiction" });
    await done;
    await stop();
    // #then
    expect({ before, after: (await feed()).includes("Fiction") }).toEqual({ before: true, after: false });
  });

  test("a book whose title changed refreshes its folder only, and the ancestor feeds keep their mtime", async () => {
    // #given
    await makeSourceFolders("Fiction/SciFi");
    await addBook("Fiction/SciFi");
    const first = run();
    let done = first.idle();
    first.processor.submit({ _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" });
    first.processor.submit({ _tag: "FolderCreated", parent: join(FILES_DIR, "Fiction"), name: "SciFi" });
    first.processor.submit({ _tag: "BookCreated", parent: join(FILES_DIR, "Fiction", "SciFi"), name: EPUB });
    await done;
    const longAgo = new Date("2020-01-01T00:00:00Z");
    const ancestors = [join(DATA_DIR, "feed.xml"), join(DATA_DIR, "Fiction", "feed.xml")];

    for (const path of ancestors) await utimes(path, longAgo, longAgo);
    // An unreadable epub falls back to the filename as title, so the book's title changes without a new file.
    await Bun.write(join(FILES_DIR, "Fiction", "SciFi", EPUB), "not an epub");
    await unlink(join(DATA_DIR, "Fiction", "SciFi", EPUB, EPUB));
    done = first.idle();
    // #when
    first.processor.submit({ _tag: "BookCreated", parent: join(FILES_DIR, "Fiction", "SciFi"), name: EPUB });
    await done;
    await first.stop();
    const mtimes = await Promise.all(ancestors.map(async (path) => (await stat(path)).mtimeMs));
    const sciFi = await feed("Fiction", "SciFi");
    // #then
    expect({
      sciFiHasNewTitle: sciFi.includes("<title>Test Book Test Author</title>"),
      sciFiKeepsOldTitle: sciFi.includes("<title>Test Book</title>"),
      mtimes,
    }).toEqual({
      sciFiHasNewTitle: true,
      sciFiKeepsOldTitle: false,
      mtimes: [longAgo.getTime(), longAgo.getTime()],
    });
  });

  test("a book added to a folder whose count changes at every level rewrites every feed.xml up to the root", async () => {
    // #given
    await makeSourceFolders("Fiction");
    const first = run();
    let done = first.idle();
    first.processor.submit({ _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" });
    await done;
    const longAgo = new Date("2020-01-01T00:00:00Z");
    const feeds = [join(DATA_DIR, "feed.xml"), join(DATA_DIR, "Fiction", "feed.xml")];

    for (const path of feeds) await utimes(path, longAgo, longAgo);
    await addBook("Fiction");
    done = first.idle();
    // #when
    first.processor.submit({ _tag: "BookCreated", parent: join(FILES_DIR, "Fiction"), name: EPUB });
    await done;
    await first.stop();
    const rewritten = await Promise.all(feeds.map(async (path) => (await stat(path)).mtimeMs > longAgo.getTime()));
    // #then
    expect(rewritten).toEqual([true, true]);
  });

  test("a new empty folder shows up in its parent's feed", async () => {
    // #given
    await makeSourceFolders("Fiction/SciFi");
    const first = run();
    let done = first.idle();
    first.processor.submit({ _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" });
    await done;
    done = first.idle();
    // #when
    first.processor.submit({ _tag: "FolderCreated", parent: join(FILES_DIR, "Fiction"), name: "SciFi" });
    await done;
    await first.stop();
    // #then
    expect((await feed("Fiction")).includes("/Fiction/SciFi/feed.xml")).toBe(true);
  });

  test("removing a book refreshes the folder feed up to the root", async () => {
    // #given
    await makeSourceFolders("Fiction");
    await addBook("Fiction");
    const { processor, idle, stop } = run();
    let done = idle();
    processor.submit({ _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" });
    processor.submit({ _tag: "BookCreated", parent: join(FILES_DIR, "Fiction"), name: EPUB });
    await done;
    const before = (await feed("Fiction")).includes("Test Book");
    await rm(join(FILES_DIR, "Fiction", EPUB));
    done = idle();
    // #when
    processor.submit({ _tag: "BookDeleted", parent: join(FILES_DIR, "Fiction"), name: EPUB });
    await done;
    await stop();
    // #then
    expect({ before, after: (await feed("Fiction")).includes("Test Book"), rootCount: (await feed()).includes("📚") }).toEqual({
      before: true,
      after: false,
      rootCount: false,
    });
  });

  test("busy and empty each fire once per period, and the feeds are complete when empty fires", async () => {
    // #given
    await makeSourceFolders("Fiction/SciFi");
    await addBook("Fiction/SciFi");
    const edges: string[] = [];
    const { processor, idle, stop } = run();
    processor.onBusy(() => edges.push("busy"));

    processor.onEmpty(() => {
      edges.push(Bun.file(join(DATA_DIR, "feed.xml")).size > 0 ? "empty:root-written" : "empty:root-missing");
    });

    const done = idle();
    // #when
    processor.submit({ _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" });
    processor.submit({ _tag: "FolderCreated", parent: join(FILES_DIR, "Fiction"), name: "SciFi" });
    processor.submit({ _tag: "BookCreated", parent: join(FILES_DIR, "Fiction", "SciFi"), name: EPUB });
    await done;
    await Bun.sleep(30);
    await stop();
    // #then
    expect(edges).toEqual(["busy", "empty:root-written"]);
  });
});
