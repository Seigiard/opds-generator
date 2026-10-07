import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { pdfExtractorRegistration } from "../../../src/formats/pdf.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const extract = (path: string) => Effect.runPromise(pdfExtractorRegistration.extract(path));

const failureTag = (path: string) => Effect.runPromise(Effect.flip(pdfExtractorRegistration.extract(path))).then((error) => error._tag);

describe("PDF extractor integration", () => {
  describe("with Test Book - Test Author.pdf", () => {
    const pdfPath = join(FIXTURES_DIR, "Test Book - Test Author.pdf");

    test("extracts all metadata fields", async () => {
      // #given a known source book
      // #when
      const { meta } = await extract(pdfPath);
      // #then
      expect(meta).toEqual({
        title: "Test Book",
        author: "Test Author",
        description: undefined,
        issued: "2025",
        subjects: ["test"],
        pageCount: 3,
      });
    });

    test("extracts the first page as a cover matching the reference", async () => {
      // #given a known source book
      // #when
      const { cover } = await extract(pdfPath);
      // #then
      await assertCoverMatchesReference(cover!);
    });
  });

  describe("edge cases", () => {
    test("fails extraction for a non-existent file", async () => {
      // #given / #when
      const tag = await failureTag("/non/existent/file.pdf");
      // #then
      expect(tag).toBe("ExtractionFailed");
    });

    test("fails extraction for a non-pdf file", async () => {
      // #given / #when
      const tag = await failureTag(join(FIXTURES_DIR, "Test Book - Test Author.epub"));
      // #then
      expect(tag).toBe("ExtractionFailed");
    });
  });
});
