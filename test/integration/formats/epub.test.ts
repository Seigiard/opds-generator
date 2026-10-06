import { describe, test, expect } from "bun:test";
import { epubHandlerRegistration } from "../../../src/formats/epub.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createTempDir, cleanupTempDir } from "../../helpers/fs-helpers.ts";

async function withEpubVariant(
  changeOpf: (xml: string) => string,
  check: (path: string) => Promise<void>,
  changeContainer: (xml: string) => string = (xml) => xml,
): Promise<void> {
  const dir = await createTempDir("epub-optional-hints");

  try {
    const contents = join(dir, "contents");
    await mkdir(contents);
    await Bun.$`unzip -q ${join(FIXTURES_DIR, "Test Book - Test Author.epub")} -d ${contents}`.quiet();
    const opf = join(contents, "content.opf");
    await Bun.write(opf, changeOpf(await Bun.file(opf).text()));
    const container = join(contents, "META-INF", "container.xml");
    await Bun.write(container, changeContainer(await Bun.file(container).text()));
    const archive = join(dir, "variant.epub");
    await Bun.$`7zz a -tzip ${archive} .`.cwd(contents).quiet();
    await check(archive);
  } finally {
    await cleanupTempDir(dir);
  }
}

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
    for (const extraRootfile of ['<rootfile full-path="other.xml" media-type="application/not-opf"/>', "<rootfile/>"]) {
      test(`keeps the real OPF when container rootfiles also contains ${extraRootfile}`, async () => {
        // #given the original EPUB plus an unrelated or empty rootfile candidate
        await withEpubVariant(
          (xml) => xml,
          async (path) => {
            // #when the handler selects the readable OPF from multiple candidates
            const handler = await epubHandlerRegistration.create(path);
            // #then the independently authored original title remains
            expect(handler?.getMetadata().title).toBe("Test Book");
          },
          (xml) => xml.replace("</rootfiles>", `${extraRootfile}</rootfiles>`),
        );
      });
    }

    test("an empty metadata element retains the original EPUB cover", async () => {
      // #given the real EPUB with only its metadata emptied
      await withEpubVariant(
        (xml) => xml.replace(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/, "<metadata/>"),
        async (path) => {
          // #when the handler falls back to the original cover filename
          const handler = await epubHandlerRegistration.create(path);
          const cover = await handler!.getCover();
          // #then the independent reference cover still matches
          expect(cover).not.toBeNull();
          await assertCoverMatchesReference(cover!);
        },
      );
    });

    test("keeps existing metadata and filename cover fallback with an empty manifest", async () => {
      // #given the real EPUB, with only its optional manifest emptied
      await withEpubVariant(
        (xml) => xml.replace(/<manifest\b[^>]*>[\s\S]*?<\/manifest>/, "<manifest/>"),
        async (path) => {
          // #when opened through the real archive boundary
          const handler = await epubHandlerRegistration.create(path);
          // #then its original independently authored metadata and cover remain
          expect(handler?.getMetadata().title).toBe("Test Book");
          const cover = await handler!.getCover();
          expect(cover).not.toBeNull();
          await assertCoverMatchesReference(cover!);
        },
      );
    });

    test("ignores an empty cover meta candidate while preserving the real EPUB", async () => {
      // #given the real EPUB plus an irrelevant empty meta element
      await withEpubVariant(
        (xml) => xml.replace("</metadata>", "<meta/></metadata>"),
        async (path) => {
          // #when opened through the real archive boundary
          const handler = await epubHandlerRegistration.create(path);
          // #then its original metadata and cover remain
          expect(handler?.getMetadata().title).toBe("Test Book");
          const cover = await handler!.getCover();
          expect(cover).not.toBeNull();
          await assertCoverMatchesReference(cover!);
        },
      );
    });

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
