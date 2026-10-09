import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";
import * as h from "./cascade-helper.ts";

describe("Cascades through the packaged engine for missing books", () => {
  beforeEach(h.resetCascadeFs);
  afterEach(h.cleanupCascadeFs);

  test("a reported book that is absent from the source publishes nothing and independent work still completes", async () => {
    await h.makeSourceFolders("Fiction", "Poetry");

    const result = await h.withSession(async ({ submit, status }) => {
      const longAgo = new Date("2020-01-01T00:00:00Z");
      const poetryFeed = join(h.dataPath, "Poetry", "feed.xml");
      await utimes(poetryFeed, longAgo, longAgo);
      await submit(
        CatalogueEvent.BookCreated({ parent: join(h.filesPath, "Fiction"), name: "missing.epub" }),
        CatalogueEvent.FolderMetaSyncRequested({ path: poetryFeed.slice(0, -9) }),
      );
      const completed = await status();

      return {
        state: completed.state,
        errors: completed.errors.map((error) => error.work._tag),
        poetry: (await h.feed("Poetry")).includes("<feed"),
        poetryRewritten: (await stat(poetryFeed)).mtimeMs > longAgo.getTime(),
        fictionBook: await Bun.file(join(h.dataPath, "Fiction", "missing.epub", "entry.xml")).exists(),
      };
    });

    expect(result).toEqual({ state: "complete", errors: [], poetry: true, poetryRewritten: true, fictionBook: false });
  });
});
