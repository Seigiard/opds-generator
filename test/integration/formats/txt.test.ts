import { describe, test, expect } from "bun:test";
import { txtHandlerRegistration } from "../../../src/formats/txt.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("TXT Handler Integration", () => {
  describe("with sample_text.txt", () => {
    const txtPath = join(FIXTURES_DIR, "sample_text.txt");

    test("creates handler successfully", async () => {
      const handler = await txtHandlerRegistration.create(txtPath);
      expect(handler).not.toBeNull();
    });

    test("returns empty metadata (title derived from filename)", async () => {
      const handler = await txtHandlerRegistration.create(txtPath);
      const metadata = handler!.getMetadata();

      expect(metadata.title).toBe("");
    });

    test("returns null for cover", async () => {
      const handler = await txtHandlerRegistration.create(txtPath);
      const cover = await handler!.getCover();

      expect(cover).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("returns null for non-existent file", async () => {
      const handler = await txtHandlerRegistration.create("/non/existent/file.txt");
      expect(handler).toBeNull();
    });
  });

  describe("handler registration", () => {
    test("has correct extensions", () => {
      expect(txtHandlerRegistration.extensions).toContain("txt");
    });

    test("has create function", () => {
      expect(typeof txtHandlerRegistration.create).toBe("function");
    });
  });
});
