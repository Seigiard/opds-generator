import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFolderStructure, computeHash, createSyncPlan, removeLegacyHeapSnapshots, scanFiles } from "../../src/scanner.ts";
import type { FileInfo } from "../../src/types.ts";

function createFileInfo(relativePath: string, size = 1000, mtime = Date.now()): FileInfo {
  return {
    path: `/files/${relativePath}`,
    relativePath,
    size,
    mtime,
    extension: relativePath.split(".").pop() || "epub",
  };
}

describe("scanner", () => {
  describe("buildFolderStructure", () => {
    test("handles empty file list", () => {
      const result = buildFolderStructure([]);
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe("");
      expect(result[0]!.name).toBe("Catalog");
      expect(result[0]!.subfolders).toEqual([]);
    });

    test("handles flat structure (files in root)", () => {
      const files = [createFileInfo("book1.epub"), createFileInfo("book2.pdf")];

      const result = buildFolderStructure(files);
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe("");
      expect(result[0]!.name).toBe("Catalog");
    });

    test("creates folder entries for nested files", () => {
      const files = [createFileInfo("Author/Book.epub")];

      const result = buildFolderStructure(files);
      expect(result).toHaveLength(2);

      const root = result.find((f) => f.path === "");
      const author = result.find((f) => f.path === "Author");

      expect(root).toBeDefined();
      expect(root!.subfolders).toContain("Author");

      expect(author).toBeDefined();
      expect(author!.name).toBe("Author");
      expect(author!.subfolders).toEqual([]);
    });

    test("handles deep nesting", () => {
      const files = [createFileInfo("A/B/C/book.epub")];

      const result = buildFolderStructure(files);
      expect(result).toHaveLength(4);

      const paths = result.map((f) => f.path).sort();
      expect(paths).toEqual(["", "A", "A/B", "A/B/C"]);

      const a = result.find((f) => f.path === "A");
      expect(a!.subfolders).toContain("A/B");

      const ab = result.find((f) => f.path === "A/B");
      expect(ab!.subfolders).toContain("A/B/C");

      const abc = result.find((f) => f.path === "A/B/C");
      expect(abc!.subfolders).toEqual([]);
    });

    test("handles multiple subfolders", () => {
      const files = [createFileInfo("Fiction/Book1.epub"), createFileInfo("NonFiction/Book2.pdf"), createFileInfo("Comics/Issue1.cbz")];

      const result = buildFolderStructure(files);
      const root = result.find((f) => f.path === "");

      expect(root!.subfolders).toHaveLength(3);
      expect(root!.subfolders).toContain("Fiction");
      expect(root!.subfolders).toContain("NonFiction");
      expect(root!.subfolders).toContain("Comics");
    });

    test("deduplicates folders from multiple files", () => {
      const files = [createFileInfo("Author/Book1.epub"), createFileInfo("Author/Book2.epub")];

      const result = buildFolderStructure(files);
      expect(result).toHaveLength(2);

      const authorFolders = result.filter((f) => f.path === "Author");
      expect(authorFolders).toHaveLength(1);
    });

    test("correctly identifies direct subfolders only", () => {
      const files = [createFileInfo("A/B/C/book.epub"), createFileInfo("A/D/book.epub")];

      const result = buildFolderStructure(files);

      const a = result.find((f) => f.path === "A");
      expect(a!.subfolders).toHaveLength(2);
      expect(a!.subfolders).toContain("A/B");
      expect(a!.subfolders).toContain("A/D");
      expect(a!.subfolders).not.toContain("A/B/C");
    });

    test("handles special characters in folder names", () => {
      const files = [createFileInfo("Author (2024)/Book [Special].epub")];

      const result = buildFolderStructure(files);
      const folder = result.find((f) => f.path === "Author (2024)");

      expect(folder).toBeDefined();
      expect(folder!.name).toBe("Author (2024)");
    });

    test("handles unicode folder names", () => {
      const files = [createFileInfo("Авторы/Книга.epub")];

      const result = buildFolderStructure(files);
      const folder = result.find((f) => f.path === "Авторы");

      expect(folder).toBeDefined();
      expect(folder!.name).toBe("Авторы");
    });
  });

  describe("computeHash", () => {
    test("returns consistent hash for same files", () => {
      const files = [createFileInfo("book1.epub", 1000, 1700000000000), createFileInfo("book2.pdf", 2000, 1700000001000)];

      const hash1 = computeHash(files);
      const hash2 = computeHash(files);

      expect(hash1).toBe(hash2);
    });

    test("returns same hash regardless of input order", () => {
      const file1 = createFileInfo("a/book.epub", 1000, 1700000000000);
      const file2 = createFileInfo("b/book.pdf", 2000, 1700000001000);

      const hash1 = computeHash([file1, file2]);
      const hash2 = computeHash([file2, file1]);

      expect(hash1).toBe(hash2);
    });

    test("returns different hash when file size changes", () => {
      const file1 = createFileInfo("book.epub", 1000, 1700000000000);
      const file2 = createFileInfo("book.epub", 2000, 1700000000000);

      expect(computeHash([file1])).not.toBe(computeHash([file2]));
    });

    test("returns different hash when file mtime changes", () => {
      const file1 = createFileInfo("book.epub", 1000, 1700000000000);
      const file2 = createFileInfo("book.epub", 1000, 1700000001000);

      expect(computeHash([file1])).not.toBe(computeHash([file2]));
    });

    test("returns different hash when file path changes", () => {
      const file1 = createFileInfo("a/book.epub", 1000, 1700000000000);
      const file2 = createFileInfo("b/book.epub", 1000, 1700000000000);

      expect(computeHash([file1])).not.toBe(computeHash([file2]));
    });

    test("returns hex string", () => {
      const files = [createFileInfo("book.epub", 1000, 1700000000000)];
      const hash = computeHash(files);

      expect(/^[0-9a-f]+$/i.test(hash)).toBe(true);
    });

    test("ignores fractional milliseconds in mtime", () => {
      const file1 = createFileInfo("book.epub", 1000, 1700000000000.5);
      const file2 = createFileInfo("book.epub", 1000, 1700000000000.9);

      expect(computeHash([file1])).toBe(computeHash([file2]));
    });
  });

  describe("removeLegacyHeapSnapshots", () => {
    test("deletes the snapshots old builds left in /data and keeps the catalogue", async () => {
      // #given
      const dataPath = await mkdtemp(join(tmpdir(), "opds-snapshots-"));
      await Bun.write(join(dataPath, "heap-snapshot-100.json"), "{}");
      await Bun.write(join(dataPath, "heap-snapshot-3000.json"), "{}");
      await Bun.write(join(dataPath, "feed.xml"), "<feed/>");
      await mkdir(join(dataPath, "Author"));

      // #when
      await removeLegacyHeapSnapshots(dataPath);

      // #then
      expect((await readdir(dataPath)).sort()).toEqual(["Author", "feed.xml"]);
      await rm(dataPath, { recursive: true, force: true });
    });

    test("does nothing when the data directory does not exist yet", async () => {
      // #given
      const dataPath = join(tmpdir(), `opds-missing-${crypto.randomUUID()}`);

      // #when
      const removed = await removeLegacyHeapSnapshots(dataPath);

      // #then
      expect(removed).toEqual([]);
    });
  });
});

describe("abortable scans and forced plans", () => {
  async function tree(): Promise<{ root: string; files: string; data: string }> {
    const root = await mkdtemp(join(tmpdir(), "opds-scan-"));
    const files = join(root, "files");
    const data = join(root, "data");
    await mkdir(join(files, "A"), { recursive: true });
    await mkdir(data, { recursive: true });
    await Bun.write(join(files, "A", "one.epub"), "x");
    await Bun.write(join(files, "A", "two.epub"), "y");

    return { root, files, data };
  }

  test("scanFiles rejects with the abort reason when the signal is already aborted", async () => {
    // #given
    const { root, files } = await tree();
    const reason = new Error("stop");
    // #when
    const outcome = await scanFiles(files, AbortSignal.abort(reason)).catch((error: Error) => error);
    // #then
    expect(outcome).toBe(reason);
    await rm(root, { recursive: true, force: true });
  });

  test("createSyncPlan rejects with the abort reason when the signal is already aborted", async () => {
    // #given
    const { root, files, data } = await tree();
    const scanned = await scanFiles(files);
    const reason = new Error("stop");
    // #when
    const outcome = await createSyncPlan(scanned, data, { signal: AbortSignal.abort(reason) }).catch((error: Error) => error);
    // #then
    expect(outcome).toBe(reason);
    await rm(root, { recursive: true, force: true });
  });

  test("a plan skips unchanged books unless forced", async () => {
    // #given both books already have an entry newer than the source file
    const { root, files, data } = await tree();

    for (const name of ["one.epub", "two.epub"]) {
      await mkdir(join(data, "A", name), { recursive: true });
      await Bun.write(join(data, "A", name, "entry.xml"), "<entry/>");
    }

    const scanned = await scanFiles(files);
    // #when
    const normal = await createSyncPlan(scanned, data);
    const forced = await createSyncPlan(scanned, data, { force: true });
    // #then
    expect({ normal: normal.toProcess.length, forced: forced.toProcess.length }).toEqual({ normal: 0, forced: 2 });
    await rm(root, { recursive: true, force: true });
  });
});
