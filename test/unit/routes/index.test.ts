import { describe, test, expect } from "bun:test";
import { resolveSafePath } from "../../../src/routes/index.ts";

describe("routes/index", () => {
  describe("resolveSafePath - Security Tests", () => {
    const BASE_PATH = "/data";

    describe("valid paths", () => {
      test("allows simple relative path", () => {
        expect(resolveSafePath(BASE_PATH, "book.epub")).toBe("/data/book.epub");
      });

      test("allows nested relative path", () => {
        expect(resolveSafePath(BASE_PATH, "author/book.epub")).toBe("/data/author/book.epub");
      });

      test("allows deeply nested path", () => {
        expect(resolveSafePath(BASE_PATH, "a/b/c/d/book.epub")).toBe("/data/a/b/c/d/book.epub");
      });

      test("allows path with spaces", () => {
        expect(resolveSafePath(BASE_PATH, "Author Name/Book Title.epub")).toBe("/data/Author Name/Book Title.epub");
      });

      test("allows path with unicode", () => {
        expect(resolveSafePath(BASE_PATH, "авторы/книга.epub")).toBe("/data/авторы/книга.epub");
      });

      test("allows path with special characters", () => {
        expect(resolveSafePath(BASE_PATH, "Author (2024)/Book [1].epub")).toBe("/data/Author (2024)/Book [1].epub");
      });
    });

    describe("path traversal attacks", () => {
      test("rejects simple path traversal", () => {
        expect(resolveSafePath(BASE_PATH, "../etc/passwd")).toBeNull();
      });

      test("rejects nested path traversal", () => {
        expect(resolveSafePath(BASE_PATH, "../../etc/passwd")).toBeNull();
        expect(resolveSafePath(BASE_PATH, "../../../etc/passwd")).toBeNull();
      });

      test("rejects path traversal at start", () => {
        expect(resolveSafePath(BASE_PATH, "../secret")).toBeNull();
      });

      test("rejects path traversal in middle", () => {
        expect(resolveSafePath(BASE_PATH, "subdir/../../../etc/passwd")).toBeNull();
      });

      test("rejects path traversal with trailing content", () => {
        expect(resolveSafePath(BASE_PATH, "../etc/passwd/../../secret")).toBeNull();
      });

      test("rejects path traversal to parent only", () => {
        expect(resolveSafePath(BASE_PATH, "..")).toBeNull();
      });

      test("rejects multiple parent traversals", () => {
        expect(resolveSafePath(BASE_PATH, "a/b/c/../../../../secret")).toBeNull();
      });
    });

    describe("absolute path attacks", () => {
      test("rejects absolute path to etc", () => {
        expect(resolveSafePath(BASE_PATH, "/etc/passwd")).toBeNull();
      });

      test("rejects absolute path to root", () => {
        expect(resolveSafePath(BASE_PATH, "/")).toBeNull();
      });

      test("rejects absolute path with data prefix", () => {
        expect(resolveSafePath(BASE_PATH, "/data/book.epub")).toBeNull();
      });

      test("rejects absolute path to tmp", () => {
        expect(resolveSafePath(BASE_PATH, "/tmp/malicious")).toBeNull();
      });
    });

    describe("edge cases", () => {
      test("handles empty path", () => {
        const result = resolveSafePath(BASE_PATH, "");
        expect(result).toBe("/data");
      });

      test("handles current directory", () => {
        expect(resolveSafePath(BASE_PATH, ".")).toBe("/data");
      });

      test("handles current directory prefix", () => {
        expect(resolveSafePath(BASE_PATH, "./book.epub")).toBe("/data/book.epub");
      });

      test("handles path exactly at boundary", () => {
        expect(resolveSafePath(BASE_PATH, "subdir/..")).toBe("/data");
      });

      test("handles multiple slashes", () => {
        const result = resolveSafePath(BASE_PATH, "a//b///c");
        expect(result).toContain("/data/");
      });

      test("handles trailing slash", () => {
        expect(resolveSafePath(BASE_PATH, "subdir/")).toBe("/data/subdir/");
      });
    });

    describe("sibling directory attacks", () => {
      test("rejects path to sibling directory", () => {
        expect(resolveSafePath("/data/books", "../images/secret.jpg")).toBeNull();
      });

      test("rejects path that escapes and re-enters", () => {
        expect(resolveSafePath(BASE_PATH, "../data-other/secret")).toBeNull();
      });

      test("rejects path with similar prefix", () => {
        expect(resolveSafePath("/data", "../data-backup/secret")).toBeNull();
      });
    });

    describe("null byte attacks", () => {
      test("rejects paths with null bytes", () => {
        expect(resolveSafePath(BASE_PATH, "file.epub\x00.jpg")).toBeNull();
        expect(resolveSafePath(BASE_PATH, "\x00malicious")).toBeNull();
        expect(resolveSafePath(BASE_PATH, "path/\x00/file")).toBeNull();
      });
    });

    describe("different base paths", () => {
      test("base path with trailing slash returns null (edge case)", () => {
        const result = resolveSafePath("/data/", "book.epub");
        expect(result).toBeNull();
      });

      test("works with nested base path", () => {
        expect(resolveSafePath("/var/lib/opds/data", "book.epub")).toBe("/var/lib/opds/data/book.epub");
      });

      test("protects nested base path from traversal", () => {
        expect(resolveSafePath("/var/lib/opds/data", "../../../../etc/passwd")).toBeNull();
      });
    });
  });
});
