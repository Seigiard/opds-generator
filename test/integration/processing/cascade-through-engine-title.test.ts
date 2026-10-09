import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";
import * as h from "./cascade-helper.ts";

describe("Cascades through the packaged engine for changed titles", () => {
  beforeEach(h.resetCascadeFs);
  afterEach(h.cleanupCascadeFs);

  test("a book whose title changed refreshes its folder only, and the ancestor feeds keep their mtime", async () => {
    await h.makeSourceFolders("Fiction/SciFi");
    const name = "Book.fb2";
    const content = await Bun.file(join(h.FIXTURES, "Test Book - Test Author.fb2")).text();
    await Bun.write(join(h.filesPath, "Fiction", "SciFi", name), content);
    const longAgo = new Date("2020-01-01T00:00:00Z");

    const result = await h.withSession(async ({ submit }) => {
      const ancestors = [join(h.dataPath, "feed.xml"), join(h.dataPath, "Fiction", "feed.xml")];

      for (const path of ancestors) await utimes(path, longAgo, longAgo);
      await Bun.write(
        join(h.filesPath, "Fiction", "SciFi", name),
        content.replace("<book-title>Test Book</book-title>", "<book-title>Changed Book</book-title>"),
      );
      await unlink(join(h.dataPath, "Fiction", "SciFi", name, name));
      await submit(CatalogueEvent.BookCreated({ parent: join(h.filesPath, "Fiction", "SciFi"), name }));
      const sciFi = await h.feed("Fiction", "SciFi");

      return {
        sciFiHasNewTitle: sciFi.includes("<title>Changed Book</title>"),
        sciFiKeepsOldTitle: sciFi.includes("<title>Test Book</title>"),
        mtimes: await Promise.all(ancestors.map(async (path) => (await stat(path)).mtimeMs)),
      };
    });

    expect(result).toEqual({ sciFiHasNewTitle: true, sciFiKeepsOldTitle: false, mtimes: [longAgo.getTime(), longAgo.getTime()] });
  });
});
