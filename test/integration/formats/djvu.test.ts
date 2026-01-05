import { describe, test, expect } from "bun:test";
import { djvuHandlerRegistration } from "../../../src/formats/djvu.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("DJVU Handler Integration", () => {
  describe("with Test Book - Test Author.djvu", () => {
    const djvuPath = join(FIXTURES_DIR, "Test Book - Test Author.djvu");

    test("creates handler successfully", async () => {
      const handler = await djvuHandlerRegistration.create(djvuPath);
      expect(handler).not.toBeNull();
    });

    test("extracts all metadata fields", async () => {
      const handler = await djvuHandlerRegistration.create(djvuPath);
      const metadata = handler!.getMetadata();

      expect(metadata.title).toBe("Test Book");
      expect(metadata.author).toBe("Test Author");
      expect(metadata.issued).toBe("2025");
      expect(metadata.subjects).toEqual(["test"]);
      expect(metadata.pageCount).toBe(3);
    });

    test("extracts cover matching reference", async () => {
      const handler = await djvuHandlerRegistration.create(djvuPath);
      const cover = await handler!.getCover();

      expect(cover).not.toBeNull();
      await assertCoverMatchesReference(cover!);
    });
  });

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await djvuHandlerRegistration.create("/non/existent/file.djvu");
      expect(handler).toBeNull();
    });

    test("returns null for non-djvu file", async () => {
      const epubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
      const handler = await djvuHandlerRegistration.create(epubPath);
      expect(handler).toBeNull();
    });
  });
});
