import { describe, test, expect } from "bun:test";
import { encodeUrlPath, formatFileSize, formatFolderDescription, normalizeFilenameTitle } from "../../src/utils/processor.ts";

describe("processor", () => {
  describe("encodeUrlPath", () => {
    test("encodes spaces", () => {
      expect(encodeUrlPath("path/with spaces/file")).toBe("path/with%20spaces/file");
    });

    test("encodes special characters", () => {
      expect(encodeUrlPath("path/file[1].epub")).toBe("path/file%5B1%5D.epub");
      expect(encodeUrlPath("path/file#hash.pdf")).toBe("path/file%23hash.pdf");
    });

    test("preserves slashes", () => {
      expect(encodeUrlPath("a/b/c/d")).toBe("a/b/c/d");
    });

    test("encodes unicode characters", () => {
      expect(encodeUrlPath("авторы/книга.epub")).toBe("%D0%B0%D0%B2%D1%82%D0%BE%D1%80%D1%8B/%D0%BA%D0%BD%D0%B8%D0%B3%D0%B0.epub");
    });

    test("encodes parentheses", () => {
      expect(encodeUrlPath("Author (2024)/Book.epub")).toBe("Author%20(2024)/Book.epub");
    });
  });

  describe("formatFileSize", () => {
    test("formats bytes", () => {
      expect(formatFileSize(0)).toBe("0 B");
      expect(formatFileSize(1)).toBe("1 B");
      expect(formatFileSize(512)).toBe("512 B");
      expect(formatFileSize(1023)).toBe("1023 B");
    });

    test("formats kilobytes", () => {
      expect(formatFileSize(1024)).toBe("1.0 KB");
      expect(formatFileSize(1536)).toBe("1.5 KB");
      expect(formatFileSize(10240)).toBe("10.0 KB");
      expect(formatFileSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    });

    test("formats megabytes", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
      expect(formatFileSize(1024 * 1024 * 1.5)).toBe("1.5 MB");
      expect(formatFileSize(1024 * 1024 * 10)).toBe("10.0 MB");
      expect(formatFileSize(1024 * 1024 * 100)).toBe("100.0 MB");
    });

    test("handles exact boundaries", () => {
      expect(formatFileSize(1024)).toBe("1.0 KB");
      expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    });
  });

  describe("normalizeFilenameTitle", () => {
    test("replaces underscores with spaces", () => {
      expect(normalizeFilenameTitle("Hello_World")).toBe("Hello World");
      expect(normalizeFilenameTitle("multiple__underscores")).toBe("multiple underscores");
    });

    test("replaces hyphens with spaces", () => {
      expect(normalizeFilenameTitle("Hello-World")).toBe("Hello World");
      expect(normalizeFilenameTitle("multiple--hyphens")).toBe("multiple hyphens");
    });

    test("replaces mixed separators", () => {
      expect(normalizeFilenameTitle("Hello_-_World")).toBe("Hello World");
      expect(normalizeFilenameTitle("a_-b-_c")).toBe("a b c");
    });

    test("normalizes multiple spaces", () => {
      expect(normalizeFilenameTitle("Hello   World")).toBe("Hello World");
    });

    test("trims whitespace", () => {
      expect(normalizeFilenameTitle("  Hello World  ")).toBe("Hello World");
      expect(normalizeFilenameTitle("_Hello_")).toBe("Hello");
    });

    test("preserves other characters", () => {
      expect(normalizeFilenameTitle("Hello (World) [2024]")).toBe("Hello (World) [2024]");
      expect(normalizeFilenameTitle("Book #1")).toBe("Book #1");
    });

    test("handles unicode", () => {
      expect(normalizeFilenameTitle("Книга_автора")).toBe("Книга автора");
    });

    test("handles complex filenames", () => {
      expect(normalizeFilenameTitle("Author_Name_-_Book_Title_(2024)")).toBe("Author Name Book Title (2024)");
    });
  });

  describe("formatFolderDescription", () => {
    test("returns undefined for empty folder", () => {
      expect(formatFolderDescription(0, 0)).toBeUndefined();
    });

    test("returns book count only when no folders", () => {
      expect(formatFolderDescription(0, 1)).toBe("📚 1");
      expect(formatFolderDescription(0, 502)).toBe("📚 502");
    });

    test("returns folder count only when no books", () => {
      expect(formatFolderDescription(1, 0)).toBe("🗂 1");
      expect(formatFolderDescription(5, 0)).toBe("🗂 5");
    });

    test("returns combined count when both present", () => {
      expect(formatFolderDescription(1, 1)).toBe("🗂 1 · 📚 1");
      expect(formatFolderDescription(5, 502)).toBe("🗂 5 · 📚 502");
    });
  });
});
