import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { mobiExtractorRegistration } from "../../../src/formats/mobi.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const MOBI_TEST_FILES = [
  { file: "Test Book - Test Author.mobi", format: "MOBI" },
  { file: "Test Book - Test Author.azw3", format: "AZW3" },
];

const extract = (path: string) => Effect.runPromise(mobiExtractorRegistration.extract(path));

const failureTag = (path: string) => Effect.runPromise(Effect.flip(mobiExtractorRegistration.extract(path))).then((error) => error._tag);

describe("MOBI extractor integration", () => {
  for (const { file, format } of MOBI_TEST_FILES) {
    describe(`${format} format`, () => {
      const filePath = join(FIXTURES_DIR, file);

      test("extracts all metadata fields", async () => {
        // #given a known source book
        // #when
        const { meta } = await extract(filePath);
        // #then
        expect(meta.title).toBe("Test Book");
        expect(meta.author).toBe("Test Author");
        expect(meta.description).toBe("Test comment Multiline");
        expect(meta.issued).toContain("2021-09-12");
        expect(meta.subjects).toEqual(["test"]);
      });

      test("extracts the embedded cover matching the reference", async () => {
        // #given a known source book
        // #when
        const { cover } = await extract(filePath);
        // #then
        await assertCoverMatchesReference(cover!);
      });
    });
  }

  describe("edge cases", () => {
    test("fails extraction for a non-existent file", async () => {
      // #given / #when
      const tag = await failureTag("/non/existent/file.mobi");
      // #then
      expect(tag).toBe("ExtractionFailed");
    });

    test("fails extraction for a non-mobi file", async () => {
      // #given / #when
      const tag = await failureTag(join(FIXTURES_DIR, "Test Book - Test Author.pdf"));
      // #then
      expect(tag).toBe("ExtractionFailed");
    });

    test("fails extraction for a truncated book whose record table runs past the end", async () => {
      // #given the first 100 bytes of a real MOBI: the header announces records the file no longer holds
      const truncated = join(tmpdir(), `opds-truncated-${Date.now()}.mobi`);
      const source = new Uint8Array(await Bun.file(join(FIXTURES_DIR, "Test Book - Test Author.mobi")).arrayBuffer());
      await Bun.write(truncated, source.subarray(0, 100));

      // #when
      const tag = await failureTag(truncated);

      // #then
      expect(tag).toBe("ExtractionFailed");
    });
  });
});
