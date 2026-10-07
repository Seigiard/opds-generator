import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { epubExtractorRegistration } from "../../../src/formats/epub.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";
import { join } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import sharp from "sharp";
import { createTempDir, cleanupTempDir } from "../../helpers/fs-helpers.ts";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const SOURCE_EPUB = join(FIXTURES_DIR, "Test Book - Test Author.epub");

const extract = (path: string) => Effect.runPromise(epubExtractorRegistration.extract(path));

const failureTag = (path: string) => Effect.runPromise(Effect.flip(epubExtractorRegistration.extract(path))).then((error) => error._tag);

interface EpubVariant {
  readonly opf?: (xml: string) => string;
  readonly container?: (xml: string) => string;
  readonly files?: (contents: string) => Promise<void>;
}

async function withEpubVariant(variant: EpubVariant, check: (path: string) => Promise<void>): Promise<void> {
  const dir = await createTempDir("epub-optional-hints");

  try {
    const contents = join(dir, "contents");
    await mkdir(contents);
    await Bun.$`unzip -q ${SOURCE_EPUB} -d ${contents}`.quiet();
    const opf = join(contents, "content.opf");
    await Bun.write(opf, (variant.opf ?? ((xml) => xml))(await Bun.file(opf).text()));
    const container = join(contents, "META-INF", "container.xml");
    await Bun.write(container, (variant.container ?? ((xml) => xml))(await Bun.file(container).text()));
    await variant.files?.(contents);
    const archive = join(dir, "variant.epub");
    await Bun.$`7zz a -tzip ${archive} .`.cwd(contents).quiet();
    await check(archive);
  } finally {
    await cleanupTempDir(dir);
  }
}

describe("EPUB extractor integration", () => {
  describe("with Test Book - Test Author.epub", () => {
    test("extracts all metadata fields", async () => {
      // #given a known EPUB 2 source book
      // #when
      const { meta } = await extract(SOURCE_EPUB);
      // #then
      expect(meta).toEqual({
        title: "Test Book",
        author: "Test Author",
        description: "Test comment Multiline",
        publisher: undefined,
        issued: "2021-09",
        language: "en",
        subjects: ["test"],
        rights: undefined,
      });
    });

    test("extracts the <meta name=cover> image matching the reference", async () => {
      // #given / #when
      const { cover } = await extract(SOURCE_EPUB);
      // #then
      await assertCoverMatchesReference(cover!);
    });
  });

  describe("cover selection", () => {
    // A decoy image that sorts before the real cover and does not match the reference.
    async function addDecoyAndMoveCover(contents: string): Promise<void> {
      await sharp({ create: { width: 300, height: 400, channels: 3, background: "#ff0000" } })
        .jpeg()
        .toFile(join(contents, "a.jpeg"));
      await mkdir(join(contents, "art"));
      await rename(join(contents, "cover.jpeg"), join(contents, "art", "front.jpeg"));
    }

    test("an EPUB 3 cover-image manifest item wins over the filename fallbacks", async () => {
      // #given an EPUB 3 package whose cover is named only by properties="cover-image"
      await withEpubVariant(
        {
          opf: (xml) =>
            xml
              .replace('<meta name="cover" content="cover"/>', "")
              .replace('href="cover.jpeg"', 'href="art/front.jpeg" properties="cover-image"'),
          files: addDecoyAndMoveCover,
        },
        async (path) => {
          // #when
          const { cover } = await extract(path);
          // #then the manifest cover, not the first sorted image, is selected
          await assertCoverMatchesReference(cover!);
        },
      );
    });

    test("a cover reference to a missing entry keeps the metadata and yields no cover", async () => {
      // #given an OPF whose cover item points to an entry absent from the archive
      await withEpubVariant({ opf: (xml) => xml.replace('href="cover.jpeg"', 'href="missing.jpeg"') }, async (path) => {
        // #when
        const { meta, cover } = await extract(path);
        // #then
        expect({ title: meta.title, author: meta.author, cover }).toEqual({ title: "Test Book", author: "Test Author", cover: null });
      });
    });
  });

  describe("edge cases", () => {
    for (const extraRootfile of ['<rootfile full-path="other.xml" media-type="application/not-opf"/>', "<rootfile/>"]) {
      test(`keeps the real OPF when container rootfiles also contains ${extraRootfile}`, async () => {
        // #given the original EPUB plus an unrelated or empty rootfile candidate
        await withEpubVariant({ container: (xml) => xml.replace("</rootfiles>", `${extraRootfile}</rootfiles>`) }, async (path) => {
          // #when the extractor selects the readable OPF from multiple candidates
          const { meta } = await extract(path);
          // #then the independently authored original title remains
          expect(meta.title).toBe("Test Book");
        });
      });
    }

    test("an empty metadata element retains the original EPUB cover", async () => {
      // #given the real EPUB with only its metadata emptied
      await withEpubVariant({ opf: (xml) => xml.replace(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/, "<metadata/>") }, async (path) => {
        // #when the extractor falls back to the original cover filename
        const { cover } = await extract(path);
        // #then the independent reference cover still matches
        await assertCoverMatchesReference(cover!);
      });
    });

    test("keeps existing metadata and filename cover fallback with an empty manifest", async () => {
      // #given the real EPUB, with only its optional manifest emptied
      await withEpubVariant({ opf: (xml) => xml.replace(/<manifest\b[^>]*>[\s\S]*?<\/manifest>/, "<manifest/>") }, async (path) => {
        // #when opened through the real archive boundary
        const { meta, cover } = await extract(path);
        // #then its original independently authored metadata and cover remain
        expect(meta.title).toBe("Test Book");
        await assertCoverMatchesReference(cover!);
      });
    });

    test("ignores an empty cover meta candidate while preserving the real EPUB", async () => {
      // #given the real EPUB plus an irrelevant empty meta element
      await withEpubVariant({ opf: (xml) => xml.replace("</metadata>", "<meta/></metadata>") }, async (path) => {
        // #when opened through the real archive boundary
        const { meta, cover } = await extract(path);
        // #then its original metadata and cover remain
        expect(meta.title).toBe("Test Book");
        await assertCoverMatchesReference(cover!);
      });
    });

    test("fails extraction when the container names no OPF", async () => {
      // #given a container without rootfiles
      await withEpubVariant({ container: (xml) => xml.replace(/<rootfiles>[\s\S]*<\/rootfiles>/, "<rootfiles/>") }, async (path) => {
        // #when / #then
        expect(await failureTag(path)).toBe("ExtractionFailed");
      });
    });

    test("fails extraction for a non-existent file", async () => {
      // #given / #when
      const tag = await failureTag("/non/existent/file.epub");
      // #then
      expect(tag).toBe("ExtractionFailed");
    });

    test("fails extraction for a non-epub file", async () => {
      // #given / #when
      const tag = await failureTag(join(FIXTURES_DIR, "Test Book - Test Author.pdf"));
      // #then
      expect(tag).toBe("ExtractionFailed");
    });
  });
});
