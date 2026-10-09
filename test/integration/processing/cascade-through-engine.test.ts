import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";
import * as h from "./cascade-helper.ts";

describe("Cascades through the packaged engine", () => {
  beforeEach(h.resetCascadeFs);
  afterEach(h.cleanupCascadeFs);

  test("a book added to a nested folder refreshes the folders whose summary changed, and stops where it did not", async () => {
    await h.makeSourceFolders("Fiction/SciFi");

    const result = await h.withSession(async ({ submit }) => {
      const rootBefore = h.updatedOf(await h.feed());
      await h.addBook("Fiction/SciFi");
      await Bun.sleep(5);
      await submit(CatalogueEvent.BookCreated({ parent: join(h.filesPath, "Fiction", "SciFi"), name: h.EPUB }));
      const [sciFi, fiction, rootFeed] = [await h.feed("Fiction", "SciFi"), await h.feed("Fiction"), await h.feed()];

      return {
        sciFiHasBook: sciFi.includes("Test Book"),
        fictionShowsSciFiCount: fiction.includes("📚 1"),
        rootRefreshed: h.updatedOf(rootFeed) !== rootBefore,
        rootListsFiction: rootFeed.includes("Fiction"),
      };
    });

    expect(result).toEqual({ sciFiHasBook: true, fictionShowsSciFiCount: true, rootRefreshed: false, rootListsFiction: true });
  });

  test("removing a top-level folder refreshes the root feed", async () => {
    await h.makeSourceFolders("Fiction");

    const result = await h.withSession(async ({ submit }) => {
      const before = (await h.feed()).includes("Fiction");
      await rm(join(h.filesPath, "Fiction"), { recursive: true });
      await submit(CatalogueEvent.FolderDeleted({ parent: h.filesPath, name: "Fiction" }));

      return { before, after: (await h.feed()).includes("Fiction") };
    });

    expect(result).toEqual({ before: true, after: false });
  });
});
