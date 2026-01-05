import { describe, test, expect } from "bun:test";
import { mobiHandlerRegistration } from "../../../src/formats/mobi.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const MOBI_TEST_FILES = [
  { file: "Test Book - Test Author.mobi", format: "MOBI" },
  { file: "Test Book - Test Author.azw3", format: "AZW3" },
];

describe("MOBI Handler Integration", () => {
  for (const { file, format } of MOBI_TEST_FILES) {
    describe(`${format} format`, () => {
      const filePath = join(FIXTURES_DIR, file);

      test("creates handler successfully", async () => {
        const handler = await mobiHandlerRegistration.create(filePath);
        expect(handler).not.toBeNull();
      });

      test("extracts all metadata fields", async () => {
        const handler = await mobiHandlerRegistration.create(filePath);
        const metadata = handler!.getMetadata();

        expect(metadata.title).toBe("Test Book");
        expect(metadata.author).toBe("Test Author");
        expect(metadata.description).toBe("Test comment Multiline");
        expect(metadata.issued).toContain("2021-09-12");
        expect(metadata.subjects).toEqual(["test"]);
      });

      test("extracts cover matching reference", async () => {
        const handler = await mobiHandlerRegistration.create(filePath);
        const cover = await handler!.getCover();

        expect(cover).not.toBeNull();
        await assertCoverMatchesReference(cover!);
      });
    });
  }

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await mobiHandlerRegistration.create("/non/existent/file.mobi");
      expect(handler).toBeNull();
    });

    test("returns null for non-mobi file", async () => {
      const pdfPath = join(FIXTURES_DIR, "Test Book - Test Author.pdf");
      const handler = await mobiHandlerRegistration.create(pdfPath);
      expect(handler).toBeNull();
    });
  });
});
