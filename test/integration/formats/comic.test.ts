import { describe, test, expect } from "bun:test";
import { comicHandlerRegistration } from "../../../src/formats/comic.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("Comic Handler Integration", () => {
  describe("with CBZ format", () => {
    const cbzPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");

    test("creates handler successfully", async () => {
      const handler = await comicHandlerRegistration.create(cbzPath);
      expect(handler).not.toBeNull();
    });

    test("extracts metadata (may be empty for comics without metadata)", async () => {
      const handler = await comicHandlerRegistration.create(cbzPath);
      const metadata = handler!.getMetadata();

      expect(typeof metadata.title).toBe("string");
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

    test("creates handler (may fail if 7zz not installed)", async () => {
      const handler = await comicHandlerRegistration.create(cb7Path);
      if (handler === null) {
        console.warn("CB7 test skipped: 7zz not available");
      }
    });

    test("extracts cover from CB7 (if handler available)", async () => {
      const handler = await comicHandlerRegistration.create(cb7Path);
      if (handler) {
        const cover = await handler.getCover();
        expect(cover).not.toBeNull();
      }
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

  describe("handler registration", () => {
    test("has correct extensions", () => {
      expect(comicHandlerRegistration.extensions).toContain("cbz");
      expect(comicHandlerRegistration.extensions).toContain("cbr");
      expect(comicHandlerRegistration.extensions).toContain("cb7");
    });

    test("has create function", () => {
      expect(typeof comicHandlerRegistration.create).toBe("function");
    });
  });
});
