import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";
import * as h from "./cascade-helper.ts";

describe("Cascades through the packaged engine for removed books", () => {
  beforeEach(h.resetCascadeFs);
  afterEach(h.cleanupCascadeFs);

  test("removing a book refreshes the folder feed up to the root", async () => {
    await h.makeSourceFolders("Fiction");
    await h.addBook("Fiction");

    const result = await h.withSession(async ({ submit }) => {
      const before = (await h.feed("Fiction")).includes("Test Book");
      await rm(join(h.filesPath, "Fiction", h.EPUB));
      await submit(CatalogueEvent.BookDeleted({ parent: join(h.filesPath, "Fiction"), name: h.EPUB }));

      return { before, after: (await h.feed("Fiction")).includes("Test Book"), rootCount: (await h.feed()).includes("📚") };
    });

    expect(result).toEqual({ before: true, after: false, rootCount: false });
  });
});
