import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { djvuExtractorRegistration } from "../../../src/formats/djvu.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const extract = (path: string) => Effect.runPromise(djvuExtractorRegistration.extract(path));

const failureTag = (path: string) => Effect.runPromise(Effect.flip(djvuExtractorRegistration.extract(path))).then((error) => error._tag);

// Longer than Linux PATH_MAX (4096), so the existence check itself fails with ENAMETOOLONG.
const PATH_TOO_LONG = `/books/${"a/".repeat(3000)}book.djvu`;

const errnoCode = (cause: unknown) => (cause instanceof Error && "code" in cause ? cause.code : undefined);

describe("DJVU extractor integration", () => {
  describe("with Test Book - Test Author.djvu", () => {
    const djvuPath = join(FIXTURES_DIR, "Test Book - Test Author.djvu");

    test("extracts all metadata fields", async () => {
      // #given a known source book
      // #when
      const { meta } = await extract(djvuPath);
      // #then
      expect(meta).toEqual({
        title: "Test Book",
        author: "Test Author",
        issued: "2025",
        subjects: ["test"],
        pageCount: 3,
      });
    });

    test("extracts the first page as a cover matching the reference", async () => {
      // #given a known source book
      // #when
      const { cover } = await extract(djvuPath);
      // #then
      await assertCoverMatchesReference(cover!);
    });
  });

  describe("edge cases", () => {
    test("fails extraction for a non-existent file", async () => {
      // #given / #when
      const tag = await failureTag("/non/existent/file.djvu");
      // #then
      expect(tag).toBe("ExtractionFailed");
    });

    test("fails extraction for a non-djvu file", async () => {
      // #given / #when
      const tag = await failureTag(join(FIXTURES_DIR, "Test Book - Test Author.epub"));
      // #then
      expect(tag).toBe("ExtractionFailed");
    });

    test("fails extraction with the path and cause when the existence check fails", async () => {
      // #given / #when
      const error = await Effect.runPromise(Effect.flip(djvuExtractorRegistration.extract(PATH_TOO_LONG)));
      // #then
      expect({ tag: error._tag, path: error.path, code: errnoCode(error.cause) }).toEqual({
        tag: "ExtractionFailed",
        path: PATH_TOO_LONG,
        code: "ENAMETOOLONG",
      });
    });
  });
});
