import { afterEach, describe, test, expect } from "bun:test";
import { listEntries, readEntry, readEntryText } from "../../../src/utils/archive.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHangingCommands, isAlive, waitForHangingChild } from "../../helpers/hanging-command.ts";

const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function abortWhileRunning(command: string, run: (signal: AbortSignal) => Promise<string[] | Buffer | null>) {
  const root = await mkdtemp(join(tmpdir(), "archive-abort-"));
  const { ready, restore } = await installHangingCommands([command], root);
  const controller = new AbortController();
  const reason = new Error("stop");

  const outcome = run(controller.signal).then(
    (value) => ({ settled: "resolved", value }),
    (error: Error) => ({ settled: "rejected", value: error === reason ? "abort reason" : String(error) }),
  );

  const child = await waitForHangingChild(ready(command));
  cleanups.push(async () => {
    restore();

    if (isAlive(child.pid)) process.kill(child.pid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  controller.abort(reason);

  return { ...(await outcome), childAlive: isAlive(child.pid) };
}

describe("utils/archive", () => {
  describe("ZIP cancellation through the Promise wrappers", () => {
    test("aborting a ZIP listing rejects with the abort reason after the command is gone", async () => {
      // #given / #when
      const outcome = await abortWhileRunning("zipinfo", (signal) =>
        listEntries(join(FIXTURES_DIR, "bobby_make_believe_sample.cbz"), signal),
      );

      // #then
      expect(outcome).toEqual({ settled: "rejected", value: "abort reason", childAlive: false });
    }, 15_000);

    test("aborting a ZIP entry read rejects with the abort reason after the command is gone", async () => {
      // #given / #when
      const outcome = await abortWhileRunning("unzip", (signal) =>
        readEntry(join(FIXTURES_DIR, "Test Book - Test Author.fb2.zip"), "Test Book - Test Author.fb2", signal),
      );

      // #then
      expect(outcome).toEqual({ settled: "rejected", value: "abort reason", childAlive: false });
    }, 15_000);
  });

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
