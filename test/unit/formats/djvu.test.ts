import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";
import { djvuExtractorRegistration } from "../../../src/formats/djvu.ts";
import { mockDdjvu, mockDjvused, resetMocks } from "../../helpers/mock-tools.ts";

// An existing file; every command that reads it is replaced by the mocks below.
const DJVU_PATH = join(import.meta.dir, "../../../files/test/Test Book - Test Author.djvu");

const PRINT_META = 'Title\t"Mock Title"\nAuthor\t"Mock Author"\nKeywords\t"alpha; beta"\nCreationDate\t"1999-12-31"\n';

const extract = () => Effect.runPromise(djvuExtractorRegistration.extract(DJVU_PATH));

const failureTag = () => Effect.runPromise(Effect.flip(djvuExtractorRegistration.extract(DJVU_PATH))).then((error) => error._tag);

afterEach(() => resetMocks());

describe("DJVU metadata commands", () => {
  test("keeps the metadata when the page count command exits nonzero", async () => {
    // #given
    mockDjvused("print-meta", { exitCode: 0, stdout: PRINT_META });
    mockDjvused("n", { exitCode: 10 });
    mockDdjvu({ exitCode: 1 });
    // #when
    const { meta } = await extract();
    // #then
    expect(meta).toEqual({ title: "Mock Title", author: "Mock Author", issued: "1999", subjects: ["alpha", "beta"] });
  });

  test("keeps the page count when the metadata command exits nonzero", async () => {
    // #given
    mockDjvused("print-meta", { exitCode: 10 });
    mockDjvused("n", { exitCode: 0, stdout: "42\n" });
    mockDdjvu({ exitCode: 1 });
    // #when
    const { meta } = await extract();
    // #then
    expect(meta).toEqual({ title: "", pageCount: 42 });
  });

  test("fails extraction when both commands exit nonzero", async () => {
    // #given
    mockDjvused("print-meta", { exitCode: 10 });
    mockDjvused("n", { exitCode: 10 });
    // #when
    const tag = await failureTag();
    // #then
    expect(tag).toBe("ExtractionFailed");
  });

  test("fails extraction when a command cannot start", async () => {
    // #given
    mockDjvused("print-meta", { exitCode: 0, stdout: PRINT_META });
    mockDjvused("n", new Error("djvused missing"));
    // #when
    const tag = await failureTag();
    // #then
    expect(tag).toBe("ExtractionFailed");
  });
});

describe("DJVU cover", () => {
  const KEPT_METADATA = { title: "Mock Title", author: "Mock Author", issued: "1999", subjects: ["alpha", "beta"], pageCount: 3 };

  function mockMetadata(): void {
    mockDjvused("print-meta", { exitCode: 0, stdout: PRINT_META });
    mockDjvused("n", { exitCode: 0, stdout: "3\n" });
  }

  test("keeps the metadata without a cover when the page command exits nonzero", async () => {
    // #given
    mockMetadata();
    mockDdjvu({ exitCode: 1 });
    // #when
    const book = await extract();
    // #then
    expect(book).toEqual({ meta: KEPT_METADATA, cover: null });
  });

  test("keeps the metadata without a cover when the page command cannot start", async () => {
    // #given
    mockMetadata();
    mockDdjvu(new Error("ddjvu missing"));
    // #when
    const book = await extract();
    // #then
    expect(book).toEqual({ meta: KEPT_METADATA, cover: null });
  });

  test("keeps the metadata without a cover when the page image cannot be converted", async () => {
    // #given a page command that succeeds but leaves an unreadable image
    mockMetadata();
    mockDdjvu({ exitCode: 0, tiff: "not a tiff" });
    // #when
    const book = await extract();
    // #then
    expect(book).toEqual({ meta: KEPT_METADATA, cover: null });
  });
});
