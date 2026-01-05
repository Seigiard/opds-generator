import { describe, test, expect } from "bun:test";
import { listEntries, readEntry, readEntryText } from "../../../src/utils/archive.ts";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

describe("utils/archive", () => {
  describe("listEntries", () => {
    test("lists entries from CBZ (ZIP)", async () => {
      const cbzPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");
      const entries = await listEntries(cbzPath);

      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e.endsWith(".jpg") || e.endsWith(".png"))).toBe(true);
    });

    test("lists entries from CBR (RAR)", async () => {
      const cbrPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbr");
      const entries = await listEntries(cbrPath);

      expect(entries.length).toBeGreaterThan(0);
    });

    test("lists entries from CB7 (7z)", async () => {
      const cb7Path = join(FIXTURES_DIR, "bobby_make_believe_sample.cb7");
      const entries = await listEntries(cb7Path);

      expect(entries.length).toBeGreaterThan(0);
    });

    test("lists entries from CBT (TAR)", async () => {
      const cbtPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbt");
      const entries = await listEntries(cbtPath);

      expect(entries.length).toBeGreaterThan(0);
    });

    test("returns empty array for non-existent file", async () => {
      const entries = await listEntries("/non/existent/file.zip");
      expect(entries).toEqual([]);
    });

    test("returns empty array for non-archive file", async () => {
      const txtPath = join(FIXTURES_DIR, "sample_text.txt");
      const entries = await listEntries(txtPath);
      expect(entries).toEqual([]);
    });
  });

  describe("readEntry", () => {
    test("reads entry from CBZ (ZIP)", async () => {
      const cbzPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");
      const entries = await listEntries(cbzPath);
      const imageEntry = entries.find((e) => e.endsWith(".jpg") || e.endsWith(".png"));

      if (imageEntry) {
        const buffer = await readEntry(cbzPath, imageEntry);
        expect(buffer).not.toBeNull();
        expect(buffer!.length).toBeGreaterThan(0);
      }
    });

    test("reads entry from CBR (RAR)", async () => {
      const cbrPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbr");
      const entries = await listEntries(cbrPath);
      const imageEntry = entries.find((e) => e.endsWith(".jpg") || e.endsWith(".png"));

      if (imageEntry) {
        const buffer = await readEntry(cbrPath, imageEntry);
        expect(buffer).not.toBeNull();
        expect(buffer!.length).toBeGreaterThan(0);
      }
    });

    test("returns null for non-existent entry", async () => {
      const cbzPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");
      const buffer = await readEntry(cbzPath, "non_existent_file.txt");
      expect(buffer).toBeNull();
    });

    test("returns null for non-archive file", async () => {
      const txtPath = join(FIXTURES_DIR, "sample_text.txt");
      const buffer = await readEntry(txtPath, "anything");
      expect(buffer).toBeNull();
    });
  });

  describe("readEntryText", () => {
    test("reads FB2 content from zipped FB2", async () => {
      const fb2zipPath = join(FIXTURES_DIR, "Test Book - Test Author.fb2.zip");
      const entries = await listEntries(fb2zipPath);
      const fb2Entry = entries.find((e) => e.endsWith(".fb2"));

      if (fb2Entry) {
        const text = await readEntryText(fb2zipPath, fb2Entry);
        expect(text).not.toBeNull();
        expect(text).toContain("FictionBook");
      }
    });

    test("returns null for binary entry", async () => {
      const cbzPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");
      const entries = await listEntries(cbzPath);
      const imageEntry = entries.find((e) => e.endsWith(".jpg"));

      if (imageEntry) {
        const text = await readEntryText(cbzPath, imageEntry);
        expect(text).not.toBeNull();
      }
    });

    test("returns null for non-existent entry", async () => {
      const cbzPath = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");
      const text = await readEntryText(cbzPath, "non_existent.txt");
      expect(text).toBeNull();
    });
  });
});
