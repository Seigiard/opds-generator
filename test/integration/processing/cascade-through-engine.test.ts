/**
 * Cascades through the packaged engine session with the real handlers on a temporary filesystem.
 * The initial pass publishes the first tree; each test then changes the source and submits the event a watcher
 * would send, so every ancestor refresh is a cascade returned by a handler.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../../src/context.ts";
import { openEngineCatalogue } from "../../../src/lifecycle/initial-engine-catalogue.ts";
import { ownedPromise } from "../../../src/utils/owned-promise.ts";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";
import type { EventType } from "../../../src/processing/types.ts";

const EPUB = "Test Book - Test Author.epub";

const FIXTURES = join(import.meta.dir, "../../../files/test");

let root = "";

let filesPath = "";

let dataPath = "";

const feed = (...segments: string[]): Promise<string> => readFile(join(dataPath, ...segments, "feed.xml"), "utf-8");

const updatedOf = (xml: string): string => /<updated>([^<]+)<\/updated>/.exec(xml)?.[1] ?? "";

async function makeSourceFolders(...folders: string[]): Promise<void> {
  for (const folder of folders) await mkdir(join(filesPath, folder), { recursive: true });
}

async function addBook(folder: string): Promise<void> {
  await Bun.write(join(filesPath, folder, EPUB), await Bun.file(join(FIXTURES, EPUB)).arrayBuffer());
}

/** Opens the engine on the current source, runs `use` once its initial publication finished, and closes the session. */
async function withSession<A>(use: (submit: (...events: EventType[]) => Promise<void>) => Promise<A>): Promise<A> {
  const ctx = await buildContext();
  const deps = { ...ctx, config: { ...ctx.config, filesPath, dataPath, reconcileInterval: 0 } };

  return Effect.runPromise(
    Effect.scoped(
      openEngineCatalogue(deps).pipe(
        Effect.flatMap((session) =>
          ownedPromise(
            () =>
              use(async (...events) => {
                await Effect.runPromise(session.submit(events));
                await Effect.runPromise(session.awaitCompletion);
              }),
            (cause) => new Error(String(cause)),
          ),
        ),
      ),
    ),
  );
}

describe("Cascades through the packaged engine", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "opds-engine-cascade-"));
    filesPath = join(root, "files");
    dataPath = join(root, "data");
    await mkdir(filesPath, { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a book added to a nested folder refreshes the folders whose summary changed, and stops where it did not", async () => {
    // #given a published nested folder without books
    await makeSourceFolders("Fiction/SciFi");

    const result = await withSession(async (submit) => {
      const rootBefore = updatedOf(await feed());
      await addBook("Fiction/SciFi");
      await Bun.sleep(5);
      // #when the book arrives
      await submit(CatalogueEvent.BookCreated({ parent: join(filesPath, "Fiction", "SciFi"), name: EPUB }));
      const [sciFi, fiction, rootFeed] = [await feed("Fiction", "SciFi"), await feed("Fiction"), await feed()];

      return {
        sciFiHasBook: sciFi.includes("Test Book"),
        fictionShowsSciFiCount: fiction.includes("📚 1"),
        rootRefreshed: updatedOf(rootFeed) !== rootBefore,
        rootListsFiction: rootFeed.includes("Fiction"),
      };
    });

    // #then
    expect(result).toEqual({ sciFiHasBook: true, fictionShowsSciFiCount: true, rootRefreshed: false, rootListsFiction: true });
  });

  test("removing a top-level folder refreshes the root feed", async () => {
    // #given a published folder
    await makeSourceFolders("Fiction");

    const result = await withSession(async (submit) => {
      const before = (await feed()).includes("Fiction");
      await rm(join(filesPath, "Fiction"), { recursive: true });
      // #when its removal is reported
      await submit(CatalogueEvent.FolderDeleted({ parent: filesPath, name: "Fiction" }));

      return { before, after: (await feed()).includes("Fiction") };
    });

    // #then
    expect(result).toEqual({ before: true, after: false });
  });

  test("a book whose title changed refreshes its folder only, and the ancestor feeds keep their mtime", async () => {
    // #given a published nested book and ancestor feeds stamped long ago
    await makeSourceFolders("Fiction/SciFi");
    const name = "Book.fb2";
    const content = await Bun.file(join(FIXTURES, "Test Book - Test Author.fb2")).text();
    await Bun.write(join(filesPath, "Fiction", "SciFi", name), content);
    const longAgo = new Date("2020-01-01T00:00:00Z");

    const result = await withSession(async (submit) => {
      const ancestors = [join(dataPath, "feed.xml"), join(dataPath, "Fiction", "feed.xml")];

      for (const path of ancestors) await utimes(path, longAgo, longAgo);
      await Bun.write(
        join(filesPath, "Fiction", "SciFi", name),
        content.replace("<book-title>Test Book</book-title>", "<book-title>Changed Book</book-title>"),
      );
      await unlink(join(dataPath, "Fiction", "SciFi", name, name));
      // #when the changed book is reported
      await submit(CatalogueEvent.BookCreated({ parent: join(filesPath, "Fiction", "SciFi"), name }));
      const sciFi = await feed("Fiction", "SciFi");

      return {
        sciFiHasNewTitle: sciFi.includes("<title>Changed Book</title>"),
        sciFiKeepsOldTitle: sciFi.includes("<title>Test Book</title>"),
        mtimes: await Promise.all(ancestors.map(async (path) => (await stat(path)).mtimeMs)),
      };
    });

    // #then
    expect(result).toEqual({ sciFiHasNewTitle: true, sciFiKeepsOldTitle: false, mtimes: [longAgo.getTime(), longAgo.getTime()] });
  });

  test("a book added to a folder whose count changes at every level rewrites every feed.xml up to the root", async () => {
    // #given a published empty folder and feeds stamped long ago
    await makeSourceFolders("Fiction");
    const longAgo = new Date("2020-01-01T00:00:00Z");

    const rewritten = await withSession(async (submit) => {
      const feeds = [join(dataPath, "feed.xml"), join(dataPath, "Fiction", "feed.xml")];

      for (const path of feeds) await utimes(path, longAgo, longAgo);
      await addBook("Fiction");
      // #when the book arrives
      await submit(CatalogueEvent.BookCreated({ parent: join(filesPath, "Fiction"), name: EPUB }));

      return Promise.all(feeds.map(async (path) => (await stat(path)).mtimeMs > longAgo.getTime()));
    });

    // #then
    expect(rewritten).toEqual([true, true]);
  });

  test("a new empty folder shows up in its parent's feed", async () => {
    // #given a published folder
    await makeSourceFolders("Fiction");

    const listed = await withSession(async (submit) => {
      await makeSourceFolders("Fiction/SciFi");
      // #when the subfolder is reported
      await submit(CatalogueEvent.FolderCreated({ parent: join(filesPath, "Fiction"), name: "SciFi" }));

      return (await feed("Fiction")).includes("/Fiction/SciFi/feed.xml");
    });

    // #then
    expect(listed).toBe(true);
  });

  test("removing a book refreshes the folder feed up to the root", async () => {
    // #given a published book
    await makeSourceFolders("Fiction");
    await addBook("Fiction");

    const result = await withSession(async (submit) => {
      const before = (await feed("Fiction")).includes("Test Book");
      await rm(join(filesPath, "Fiction", EPUB));
      // #when its removal is reported
      await submit(CatalogueEvent.BookDeleted({ parent: join(filesPath, "Fiction"), name: EPUB }));

      return { before, after: (await feed("Fiction")).includes("Test Book"), rootCount: (await feed()).includes("📚") };
    });

    // #then
    expect(result).toEqual({ before: true, after: false, rootCount: false });
  });

  test("a reported book that is absent from the source publishes nothing and independent work still completes", async () => {
    // #given published folders and a book event whose source file does not exist
    await makeSourceFolders("Fiction", "Poetry");

    const result = await withSession(async (submit) => {
      // #when the missing book is reported beside an independent refresh
      await submit(
        CatalogueEvent.BookCreated({ parent: join(filesPath, "Fiction"), name: "missing.epub" }),
        CatalogueEvent.FolderMetaSyncRequested({ path: join(dataPath, "Poetry") }),
      );

      return {
        poetry: (await feed("Poetry")).includes("<feed"),
        fictionBook: await Bun.file(join(dataPath, "Fiction", "missing.epub", "entry.xml")).exists(),
      };
    });

    // #then
    expect(result).toEqual({ poetry: true, fictionBook: false });
  });
});
