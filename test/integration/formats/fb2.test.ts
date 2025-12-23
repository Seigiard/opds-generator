import { describe, test, expect } from "bun:test";
import { fb2HandlerRegistration } from "../../../src/formats/fb2.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const FB2_TEST_FILES = [
  { file: "Test Book - Test Author.fb2", format: "FB2" },
  { file: "Test Book - Test Author.fb2.zip", format: "FB2.zip" },
  { file: "Test Book - Test Author.fbz", format: "FBZ" },
];

describe("FB2 Handler Integration", () => {
  for (const { file, format } of FB2_TEST_FILES) {
    describe(`${format} format`, () => {
      const filePath = join(FIXTURES_DIR, file);

      test("creates handler successfully", async () => {
        const handler = await fb2HandlerRegistration.create(filePath);
        expect(handler).not.toBeNull();
      });

      test("extracts all metadata fields", async () => {
        const handler = await fb2HandlerRegistration.create(filePath);
        const metadata = handler!.getMetadata();

        expect(metadata.title).toBe("Test Book");
        expect(metadata.author).toBe("Test Author");
        expect(metadata.description).toBe("Test comment Multiline");
        expect(metadata.language).toBe("en");
        expect(metadata.subjects).toEqual(["test"]);
        expect(metadata.series).toBe("Test Series");
      });

      test("extracts cover matching reference", async () => {
        const handler = await fb2HandlerRegistration.create(filePath);
        const cover = await handler!.getCover();

        expect(cover).not.toBeNull();
        await assertCoverMatchesReference(cover!);
      });
    });
  }

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await fb2HandlerRegistration.create("/non/existent/file.fb2");
      expect(handler).toBeNull();
    });

    test("returns null for non-fb2 file", async () => {
      const pdfPath = join(FIXTURES_DIR, "Test Book - Test Author.pdf");
      const handler = await fb2HandlerRegistration.create(pdfPath);
      expect(handler).toBeNull();
    });
  });

  describe("handler registration", () => {
    test("has correct extensions", () => {
      expect(fb2HandlerRegistration.extensions).toContain("fb2");
      expect(fb2HandlerRegistration.extensions).toContain("fbz");
    });

    test("has create function", () => {
      expect(typeof fb2HandlerRegistration.create).toBe("function");
    });
  });
});
