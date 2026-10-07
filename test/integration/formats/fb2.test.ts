import { afterAll, beforeAll, describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fb2ExtractorRegistration } from "../../../src/formats/fb2.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { createTempDir, cleanupTempDir } from "../../helpers/fs-helpers.ts";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const SOURCE_FB2 = join(FIXTURES_DIR, "Test Book - Test Author.fb2");

const FB2_TEST_FILES = [
  { file: "Test Book - Test Author.fb2", format: "FB2" },
  { file: "Test Book - Test Author.fb2.zip", format: "FB2.zip" },
  { file: "Test Book - Test Author.fbz", format: "FBZ" },
];

const extract = (path: string) => Effect.runPromise(fb2ExtractorRegistration.extract(path));

const failureTag = (path: string) => Effect.runPromise(Effect.flip(fb2ExtractorRegistration.extract(path))).then((error) => error._tag);

let dir = "";

beforeAll(async () => {
  dir = await createTempDir("fb2-extract");
});

afterAll(async () => {
  await cleanupTempDir(dir);
});

/** Writes the known FB2 with `edit` applied; throws when the edit leaves the source unchanged. */
async function writeEditedFb2(name: string, edit: (source: string) => string): Promise<string> {
  const source = await Bun.file(SOURCE_FB2).text();
  const xml = edit(source);

  if (xml === source) throw new Error(`FB2 fixture edit for ${name} changed nothing`);
  const path = join(dir, name);
  await Bun.write(path, xml);

  return path;
}

describe("FB2 extraction", () => {
  for (const { file, format } of FB2_TEST_FILES) {
    describe(`${format} format`, () => {
      const filePath = join(FIXTURES_DIR, file);

      test("extracts all metadata fields", async () => {
        // #given / #when
        const { meta } = await extract(filePath);

        // #then
        expect(meta).toEqual({
          title: "Test Book",
          author: "Test Author",
          description: "Test comment Multiline",
          publisher: undefined,
          issued: undefined,
          language: "en",
          subjects: ["test"],
          series: "Test Series",
        });
      });

      test("extracts cover matching reference", async () => {
        // #given / #when
        const { cover } = await extract(filePath);

        // #then
        expect(cover).not.toBeNull();
        await assertCoverMatchesReference(cover!);
      });
    });
  }

  describe("edge cases", () => {
    for (const nickname of ["123", "true"]) {
      test(`preserves nickname-only author text ${nickname}`, async () => {
        // #given the existing FB2 with a nickname-only author; nickname is text in FB2
        const path = await writeEditedFb2(`nickname-${nickname}.fb2`, (source) =>
          source.replace(/<author>[\s\S]*?<\/author>/, `<author><nickname>${nickname}</nickname></author>`),
        );

        // #when the real parser and metadata mapping decode the book
        const { meta } = await extract(path);

        // #then the domain's string author contract preserves the XML text
        expect(meta.author).toBe(nickname);
      });
    }

    test("returns no cover but keeps metadata when the cover reference names no binary", async () => {
      // #given the known FB2 whose only binary has a different id than the coverpage reference
      const path = await writeEditedFb2("missing-binary.fb2", (source) => source.replace('<binary id="img_0"', '<binary id="other"'));

      // #when
      const book = await extract(path);

      // #then
      expect({ title: book.meta.title, author: book.meta.author, cover: book.cover }).toEqual({
        title: "Test Book",
        author: "Test Author",
        cover: null,
      });
    });

    test("returns no cover but keeps metadata when the book has no coverpage", async () => {
      // #given
      const path = await writeEditedFb2("no-coverpage.fb2", (source) => source.replace(/<coverpage>[\s\S]*?<\/coverpage>/, ""));

      // #when
      const book = await extract(path);

      // #then
      expect({ title: book.meta.title, series: book.meta.series, cover: book.cover }).toEqual({
        title: "Test Book",
        series: "Test Series",
        cover: null,
      });
    });

    test("reads the first FB2 entry in archive order", async () => {
      // #given an FBZ holding two books; the later-named one is stored first (TAR keeps argument order, 7zz sorts ZIP entries)
      const contents = join(dir, "two-books");
      await mkdir(contents, { recursive: true });
      await writeEditedFb2("two-books/z-first.fb2", (source) =>
        source.replace("<book-title>Test Book</book-title>", "<book-title>Stored First</book-title>"),
      );
      await writeEditedFb2("two-books/a-second.fb2", (source) =>
        source.replace("<book-title>Test Book</book-title>", "<book-title>Stored Second</book-title>"),
      );
      const path = join(dir, "two-books.fbz");
      await Bun.$`tar -cf ${path} z-first.fb2 a-second.fb2`.cwd(contents).quiet();

      // #when
      const { meta } = await extract(path);

      // #then
      expect(meta.title).toBe("Stored First");
    });

    test("reads an FBZ packed as a TAR archive", async () => {
      // #given the known FB2 inside a TAR container under an .fbz name
      const contents = join(dir, "tar-contents");
      await mkdir(contents, { recursive: true });
      await Bun.write(join(contents, "book.fb2"), Bun.file(SOURCE_FB2));
      const path = join(dir, "tar-packed.fbz");
      await Bun.$`tar -cf ${path} book.fb2`.cwd(contents).quiet();

      // #when
      const book = await extract(path);

      // #then
      expect({ title: book.meta.title, author: book.meta.author }).toEqual({ title: "Test Book", author: "Test Author" });
      await assertCoverMatchesReference(book.cover!);
    });

    test("fails extraction when an FBZ archive holds no FB2 entry", async () => {
      // #given
      const contents = join(dir, "no-fb2");
      await mkdir(contents, { recursive: true });
      await Bun.write(join(contents, "readme.txt"), "not a book");
      const path = join(dir, "no-fb2.fbz");
      await Bun.$`7zz a -tzip ${path} readme.txt`.cwd(contents).quiet();

      // #when
      const tag = await failureTag(path);

      // #then
      expect(tag).toBe("ExtractionFailed");
    });

    test.each([
      ["empty file", ""],
      ["plain text", "just some text"],
      ["XML without a FictionBook root", "<html><body>hello</body></html>"],
      ["FictionBook without elements", "<FictionBook>text only</FictionBook>"],
    ])("fails extraction for %s", async (_name, content) => {
      // #given
      const path = join(dir, `unusable-${content.length}.fb2`);
      await Bun.write(path, content);

      // #when
      const tag = await failureTag(path);

      // #then
      expect(tag).toBe("ExtractionFailed");
    });

    test("fails extraction for a non-existent file", async () => {
      // #given / #when
      const tag = await failureTag("/non/existent/file.fb2");

      // #then
      expect(tag).toBe("ExtractionFailed");
    });

    test("fails extraction for a non-fb2 file", async () => {
      // #given / #when
      const tag = await failureTag(join(FIXTURES_DIR, "Test Book - Test Author.pdf"));

      // #then
      expect(tag).toBe("ExtractionFailed");
    });
  });
});
