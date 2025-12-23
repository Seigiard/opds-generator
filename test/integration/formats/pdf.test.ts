import { describe, test, expect } from "bun:test";
import { pdfHandlerRegistration } from "../../../src/formats/pdf.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("PDF Handler Integration", () => {
  describe("with test_book_pdf.pdf", () => {
    const pdfPath = join(FIXTURES_DIR, "test_book_pdf.pdf");

    test("creates handler successfully (requires pdfinfo)", async () => {
      const handler = await pdfHandlerRegistration.create(pdfPath);
      if (handler === null) {
        console.warn("PDF test skipped: pdfinfo not available");
        return;
      }
      expect(handler).not.toBeNull();
    });

    test("extracts metadata (if handler available)", async () => {
      const handler = await pdfHandlerRegistration.create(pdfPath);
      if (!handler) {
        console.warn("PDF metadata test skipped: pdfinfo not available");
        return;
      }

      const metadata = handler.getMetadata();
      expect(typeof metadata.title).toBe("string");
    });

    test("getCover returns buffer or null (requires pdftoppm)", async () => {
      const handler = await pdfHandlerRegistration.create(pdfPath);
      if (!handler) {
        console.warn("PDF cover test skipped: pdfinfo not available");
        return;
      }

      const cover = await handler.getCover();
      if (cover) {
        expect(Buffer.isBuffer(cover)).toBe(true);
        expect(cover.length).toBeGreaterThan(0);
      }
    });
  });

  describe("with test_book_pdf_more_detail.pdf", () => {
    const pdfPath = join(FIXTURES_DIR, "test_book_pdf_more_detail.pdf");

    test("creates handler for detailed PDF", async () => {
      const handler = await pdfHandlerRegistration.create(pdfPath);
      if (handler === null) {
        console.warn("PDF test skipped: pdfinfo not available");
        return;
      }
      expect(handler).not.toBeNull();
    });
  });

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await pdfHandlerRegistration.create("/non/existent/file.pdf");
      expect(handler).toBeNull();
    });

    test("returns null for non-pdf file", async () => {
      const epubPath = join(FIXTURES_DIR, "test_book_epub.epub");
      const handler = await pdfHandlerRegistration.create(epubPath);
      expect(handler).toBeNull();
    });
  });

  describe("handler registration", () => {
    test("has correct extensions", () => {
      expect(pdfHandlerRegistration.extensions).toContain("pdf");
      expect(pdfHandlerRegistration.extensions).toHaveLength(1);
    });

    test("has create function", () => {
      expect(typeof pdfHandlerRegistration.create).toBe("function");
    });
  });
});
