import { describe, test, expect } from "bun:test";
import { pdfHandlerRegistration } from "../../../src/formats/pdf.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("PDF Handler Integration", () => {
  describe("with Test Book - Test Author.pdf", () => {
    const pdfPath = join(FIXTURES_DIR, "Test Book - Test Author.pdf");

    test("creates handler successfully", async () => {
      const handler = await pdfHandlerRegistration.create(pdfPath);
      expect(handler).not.toBeNull();
    });

    test("extracts all metadata fields", async () => {
      const handler = await pdfHandlerRegistration.create(pdfPath);
      const metadata = handler!.getMetadata();

      expect(metadata.title).toBe("Test Book");
      expect(metadata.author).toBe("Test Author");
      expect(metadata.issued).toBe("2025");
      expect(metadata.subjects).toEqual(["test"]);
      expect(metadata.pageCount).toBe(3);
    });

    test("extracts cover image", async () => {
      const handler = await pdfHandlerRegistration.create(pdfPath);
      const cover = await handler!.getCover();

      expect(cover).not.toBeNull();
      expect(Buffer.isBuffer(cover)).toBe(true);
      expect(cover!.length).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await pdfHandlerRegistration.create("/non/existent/file.pdf");
      expect(handler).toBeNull();
    });

    test("returns null for non-pdf file", async () => {
      const epubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
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
