import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";
import * as h from "./cascade-helper.ts";

describe("Cascades through the packaged engine for count changes", () => {
  beforeEach(h.resetCascadeFs);
  afterEach(h.cleanupCascadeFs);

  test("a book added to a folder whose count changes at every level rewrites every feed.xml up to the root", async () => {
    await h.makeSourceFolders("Fiction");
    const longAgo = new Date("2020-01-01T00:00:00Z");

    const rewritten = await h.withSession(async ({ submit }) => {
      const feeds = [join(h.dataPath, "feed.xml"), join(h.dataPath, "Fiction", "feed.xml")];

      for (const path of feeds) await utimes(path, longAgo, longAgo);
      await h.addBook("Fiction");
      await submit(CatalogueEvent.BookCreated({ parent: join(h.filesPath, "Fiction"), name: h.EPUB }));

      return Promise.all(feeds.map(async (path) => (await stat(path)).mtimeMs > longAgo.getTime()));
    });

    expect(rewritten).toEqual([true, true]);
  });

  test("a new empty folder shows up in its parent's feed", async () => {
    await h.makeSourceFolders("Fiction");

    const listed = await h.withSession(async ({ submit }) => {
      await h.makeSourceFolders("Fiction/SciFi");
      await submit(CatalogueEvent.FolderCreated({ parent: join(h.filesPath, "Fiction"), name: "SciFi" }));

      return (await h.feed("Fiction")).includes("/Fiction/SciFi/feed.xml");
    });

    expect(listed).toBe(true);
  });
});
