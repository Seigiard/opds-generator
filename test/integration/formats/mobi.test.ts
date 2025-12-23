import { describe, test, expect } from "bun:test";
import { mobiHandlerRegistration } from "../../../src/formats/mobi.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("MOBI Handler Integration", () => {
  describe("with test_book_epub_more_detail.mobi", () => {
    const mobiPath = join(FIXTURES_DIR, "test_book_epub_more_detail.mobi");

    test("creates handler successfully", async () => {
      const handler = await mobiHandlerRegistration.create(mobiPath);
      expect(handler).not.toBeNull();
    });

    test("extracts metadata", async () => {
      const handler = await mobiHandlerRegistration.create(mobiPath);
      const metadata = handler!.getMetadata();

      expect(metadata.title).toBeTruthy();
      expect(typeof metadata.title).toBe("string");
    });

    test("getCover returns buffer or null", async () => {
      const handler = await mobiHandlerRegistration.create(mobiPath);
      const cover = await handler!.getCover();

      if (cover) {
        expect(Buffer.isBuffer(cover)).toBe(true);
        expect(cover.length).toBeGreaterThan(0);
      }
    });
  });

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await mobiHandlerRegistration.create("/non/existent/file.mobi");
      expect(handler).toBeNull();
    });

    test("returns null for non-mobi file", async () => {
      const pdfPath = join(FIXTURES_DIR, "test_book_pdf.pdf");
      const handler = await mobiHandlerRegistration.create(pdfPath);
      expect(handler).toBeNull();
    });
  });

  describe("handler registration", () => {
    test("has correct extensions", () => {
      expect(mobiHandlerRegistration.extensions).toContain("mobi");
      expect(mobiHandlerRegistration.extensions).toContain("azw");
      expect(mobiHandlerRegistration.extensions).toContain("azw3");
    });

    test("has create function", () => {
      expect(typeof mobiHandlerRegistration.create).toBe("function");
    });
  });
});
