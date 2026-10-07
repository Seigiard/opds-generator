import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { txtExtractorRegistration } from "../../../src/formats/txt.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("TXT extractor integration", () => {
  test("extracts an empty title and no cover, leaving the title to the filename", async () => {
    // #given
    const txtPath = join(FIXTURES_DIR, "sample_text.txt");

    // #when
    const book = await Effect.runPromise(txtExtractorRegistration.extract(txtPath));

    // #then
    expect(book).toEqual({ meta: { title: "" }, cover: null });
  });

  test("fails extraction for a non-existent file", async () => {
    // #given / #when
    const error = await Effect.runPromise(Effect.flip(txtExtractorRegistration.extract("/non/existent/file.txt")));

    // #then
    expect(error._tag).toBe("ExtractionFailed");
  });
});
