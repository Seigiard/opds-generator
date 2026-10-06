import { describe, test, expect } from "bun:test";
import { comicHandlerRegistration } from "../../../src/formats/comic.ts";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createTempDir, cleanupTempDir } from "../../helpers/fs-helpers.ts";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("Comic Handler Integration", () => {
  describe("with CBZ format", () => {
    const cbzPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");

    test("an incomplete page hint does not discard a later valid front cover", async () => {
      // #given the existing image fixture plus incomplete and valid page hints
      const dir = await createTempDir("comic-page-hints");

      try {
        const contents = join(dir, "contents");
        await mkdir(contents);
        await Bun.$`unzip -q ${cbzPath} -d ${contents}`.quiet();
        await Bun.write(
          join(contents, "ComicInfo.xml"),
          '<ComicInfo><Pages><Page Type="Story"/><Page Image="1" Type="FrontCover"/></Pages></ComicInfo>',
        );
        const archive = join(dir, "variant.cbz");
        await Bun.$`7zz a -tzip ${archive} .`.cwd(contents).quiet();

        const expected = await Bun.$`unzip -p ${cbzPath} Bobby-Make-Believe_1915__1.jpg`.arrayBuffer();

        // #when selecting the cover through the real handler
        const handler = await comicHandlerRegistration.create(archive);
        const cover = await handler!.getCover();
        // #then the existing second image wins despite the preceding incomplete hint
        expect(cover).toEqual(Buffer.from(expected));
      } finally {
        await cleanupTempDir(dir);
      }
    });

    test("creates handler successfully", async () => {
      const handler = await comicHandlerRegistration.create(cbzPath);
      expect(handler).not.toBeNull();
    });

    test("returns an empty title for the image-only CBZ fixture", async () => {
      const handler = await comicHandlerRegistration.create(cbzPath);
      const metadata = handler!.getMetadata();

      expect(metadata.title).toBe("");
    });

    test("getCover returns buffer", async () => {
      const handler = await comicHandlerRegistration.create(cbzPath);
      const cover = await handler!.getCover();

      expect(cover).not.toBeNull();
      expect(Buffer.isBuffer(cover)).toBe(true);
      expect(cover!.length).toBeGreaterThan(0);
    });
  });

  describe("with CBR format", () => {
    const cbrPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbr");

    test("creates handler successfully", async () => {
      const handler = await comicHandlerRegistration.create(cbrPath);
      expect(handler).not.toBeNull();
    });

    test("extracts cover from CBR", async () => {
      const handler = await comicHandlerRegistration.create(cbrPath);
      const cover = await handler!.getCover();

      expect(cover).not.toBeNull();
    });
  });

  describe("with CB7 format (requires 7zz)", () => {
    const cb7Path = join(FIXTURES_DIR, "bobby_make_believe_sample.cb7");

    test("creates handler successfully", async () => {
      const handler = await comicHandlerRegistration.create(cb7Path);
      expect(handler).not.toBeNull();
    });

    test("extracts cover from CB7", async () => {
      const handler = await comicHandlerRegistration.create(cb7Path);
      const cover = await handler!.getCover();
      expect(cover).not.toBeNull();
    });
  });

  describe("with CBT format (TAR)", () => {
    const cbtPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbt");

    test("creates handler successfully", async () => {
      const handler = await comicHandlerRegistration.create(cbtPath);
      expect(handler).not.toBeNull();
    });

    test("extracts cover from CBT", async () => {
      const handler = await comicHandlerRegistration.create(cbtPath);
      const cover = await handler!.getCover();

      expect(cover).not.toBeNull();
      expect(Buffer.isBuffer(cover)).toBe(true);
    });
  });

  describe("with magazine CBZ (Elf Receiver)", () => {
    const magazinePath = join(FIXTURES_DIR, "Elf_Receiver_Radio-Craft_August_1936.cbz");

    test("creates handler for magazine CBZ", async () => {
      const handler = await comicHandlerRegistration.create(magazinePath);
      expect(handler).not.toBeNull();
    });
  });

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await comicHandlerRegistration.create("/non/existent/file.cbz");
      expect(handler).toBeNull();
    });

    test("returns null for non-comic file", async () => {
      const pdfPath = join(FIXTURES_DIR, "test_book_pdf.pdf");
      const handler = await comicHandlerRegistration.create(pdfPath);
      expect(handler).toBeNull();
    });
  });
});
