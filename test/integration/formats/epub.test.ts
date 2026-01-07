import { describe, test, expect } from "bun:test";
import { epubHandlerRegistration } from "../../../src/formats/epub.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("EPUB Handler Integration", () => {
  describe("with Test Book - Test Author.epub", () => {
    const epubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");

    test("creates handler successfully", async () => {
      const handler = await epubHandlerRegistration.create(epubPath);
      expect(handler).not.toBeNull();
    });

    test("extracts all metadata fields", async () => {
      const handler = await epubHandlerRegistration.create(epubPath);
      const metadata = handler!.getMetadata();

      expect(metadata.title).toBe("Test Book");
      expect(metadata.author).toBe("Test Author");
      expect(metadata.description).toBe("Test comment Multiline");
      expect(metadata.issued).toBe("2021-09");
      expect(metadata.language).toBe("en");
      expect(metadata.subjects).toEqual(["test"]);
    });

    test("extracts cover matching reference", async () => {
      const handler = await epubHandlerRegistration.create(epubPath);
      const cover = await handler!.getCover();

      expect(cover).not.toBeNull();
      await assertCoverMatchesReference(cover!);
    });
  });

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await epubHandlerRegistration.create("/non/existent/file.epub");
      expect(handler).toBeNull();
    });

    test("returns null for non-epub file", async () => {
      const pdfPath = join(FIXTURES_DIR, "Test Book - Test Author.pdf");
      const handler = await epubHandlerRegistration.create(pdfPath);
      expect(handler).toBeNull();
    });
  });
});
