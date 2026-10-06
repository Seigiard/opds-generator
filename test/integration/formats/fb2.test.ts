import { describe, test, expect } from "bun:test";
import { fb2HandlerRegistration } from "../../../src/formats/fb2.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";
import { createTempDir, cleanupTempDir } from "../../helpers/fs-helpers.ts";

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
    for (const nickname of ["123", "true"]) {
      test(`preserves nickname-only author text ${nickname}`, async () => {
        // #given the existing FB2 with a nickname-only author; nickname is text in FB2
        const dir = await createTempDir("fb2-nickname");

        try {
          const source = await Bun.file(join(FIXTURES_DIR, "Test Book - Test Author.fb2")).text();

          const xml = source.replace(/<author>[\s\S]*?<\/author>/, `<author><nickname>${nickname}</nickname></author>`);

          if (xml === source) throw new Error("FB2 fixture has no author to replace");
          const path = join(dir, "nickname.fb2");
          await Bun.write(path, xml);
          // #when the real parser and metadata handler decode the book
          const handler = await fb2HandlerRegistration.create(path);
          // #then the domain's string author contract preserves the XML text
          expect(handler?.getMetadata().author).toBe(nickname);
        } finally {
          await cleanupTempDir(dir);
        }
      });
    }

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
});
