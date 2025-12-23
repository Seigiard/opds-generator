import { describe, test, expect } from "bun:test";
import { fb2HandlerRegistration } from "../../../src/formats/fb2.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("FB2 Handler Integration", () => {
  describe("with source_test_book_fb2.fb2", () => {
    const fb2Path = join(FIXTURES_DIR, "source_test_book_fb2.fb2");

    test("creates handler successfully", async () => {
      const handler = await fb2HandlerRegistration.create(fb2Path);
      expect(handler).not.toBeNull();
    });

    test("extracts metadata", async () => {
      const handler = await fb2HandlerRegistration.create(fb2Path);
      const metadata = handler!.getMetadata();

      expect(metadata.title).toBeTruthy();
      expect(typeof metadata.title).toBe("string");
    });

    test("getCover returns buffer or null", async () => {
      const handler = await fb2HandlerRegistration.create(fb2Path);
      const cover = await handler!.getCover();

      if (cover) {
        expect(Buffer.isBuffer(cover)).toBe(true);
        expect(cover.length).toBeGreaterThan(0);
      }
    });
  });

  describe("with compressed FB2 (not supported by fb2 handler)", () => {
    test(".fbz is NOT handled by fb2 handler (returns null)", async () => {
      const fbzPath = join(FIXTURES_DIR, "source_test_book_fb2_zip.fbz");
      const handler = await fb2HandlerRegistration.create(fbzPath);
      expect(handler).toBeNull();
    });

    test(".fb2.zip is NOT handled by fb2 handler (returns null)", async () => {
      const zipPath = join(FIXTURES_DIR, "source_test_book_fb2_dot_zip.fb2.zip");
      const handler = await fb2HandlerRegistration.create(zipPath);
      expect(handler).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await fb2HandlerRegistration.create("/non/existent/file.fb2");
      expect(handler).toBeNull();
    });

    test("returns null for non-fb2 file", async () => {
      const pdfPath = join(FIXTURES_DIR, "test_book_pdf.pdf");
      const handler = await fb2HandlerRegistration.create(pdfPath);
      expect(handler).toBeNull();
    });
  });

  describe("handler registration", () => {
    test("has correct extensions (fb2 only)", () => {
      expect(fb2HandlerRegistration.extensions).toContain("fb2");
      expect(fb2HandlerRegistration.extensions).toHaveLength(1);
    });

    test("has create function", () => {
      expect(typeof fb2HandlerRegistration.create).toBe("function");
    });
  });
});
