import { describe, test, expect } from "bun:test";
import { epubHandlerRegistration } from "../../../src/formats/epub.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("EPUB Handler Integration", () => {
  describe("with test_book_epub.epub", () => {
    const epubPath = join(FIXTURES_DIR, "test_book_epub.epub");

    test("creates handler successfully", async () => {
      const handler = await epubHandlerRegistration.create(epubPath);
      expect(handler).not.toBeNull();
    });

    test("extracts metadata", async () => {
      const handler = await epubHandlerRegistration.create(epubPath);
      const metadata = handler!.getMetadata();

      expect(metadata.title).toBeTruthy();
      expect(typeof metadata.title).toBe("string");
    });

    test("getCover returns buffer or null", async () => {
      const handler = await epubHandlerRegistration.create(epubPath);
      const cover = await handler!.getCover();

      if (cover) {
        expect(Buffer.isBuffer(cover)).toBe(true);
        expect(cover.length).toBeGreaterThan(0);
      }
    });
  });

  describe("with test_book_epub_more_detail.epub", () => {
    const epubPath = join(FIXTURES_DIR, "test_book_epub_more_detail.epub");

    test("creates handler successfully", async () => {
      const handler = await epubHandlerRegistration.create(epubPath);
      expect(handler).not.toBeNull();
    });

    test("extracts detailed metadata", async () => {
      const handler = await epubHandlerRegistration.create(epubPath);
      const metadata = handler!.getMetadata();

      expect(metadata.title).toBeTruthy();
    });
  });

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await epubHandlerRegistration.create("/non/existent/file.epub");
      expect(handler).toBeNull();
    });

    test("returns null for non-epub file", async () => {
      const pdfPath = join(FIXTURES_DIR, "test_book_pdf.pdf");
      const handler = await epubHandlerRegistration.create(pdfPath);
      expect(handler).toBeNull();
    });
  });

  describe("handler registration", () => {
    test("has correct extensions", () => {
      expect(epubHandlerRegistration.extensions).toContain("epub");
    });

    test("has create function", () => {
      expect(typeof epubHandlerRegistration.create).toBe("function");
    });
  });
});
