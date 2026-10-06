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
    test("replaces underscores with spaces when majority separator", () => {
      expect(normalizeFilenameTitle("Hello_World")).toBe("Hello World");
      expect(normalizeFilenameTitle("multiple__underscores")).toBe("Multiple underscores");
    });

    test("replaces hyphens with spaces when majority separator", () => {
      expect(normalizeFilenameTitle("my-awesome-book")).toBe("My awesome book");
      expect(normalizeFilenameTitle("multiple--hyphens")).toBe("Multiple hyphens");
    });

    test("preserves minority separator", () => {
      expect(normalizeFilenameTitle("sci-fi_books_2024")).toBe("Sci-fi books 2024");
      expect(normalizeFilenameTitle("book_about_a-b")).toBe("Book about a-b");
      expect(normalizeFilenameTitle("test-very-long_title")).toBe("Test very long_title");
    });

    test("prefers underscore as separator when equal count", () => {
      expect(normalizeFilenameTitle("e-book_collection")).toBe("E-book collection");
    });

    test("splits camelCase", () => {
      expect(normalizeFilenameTitle("camelCase")).toBe("Camel Case");
      expect(normalizeFilenameTitle("TheLordOfTheRings")).toBe("The Lord Of The Rings");
      expect(normalizeFilenameTitle("XMLParser")).toBe("XML Parser");
    });

    test("normalizes multiple spaces", () => {
      expect(normalizeFilenameTitle("Hello   World")).toBe("Hello World");
    });

    test("trims whitespace and edge separators", () => {
      expect(normalizeFilenameTitle("  Hello World  ")).toBe("Hello World");
      expect(normalizeFilenameTitle("_Hello_")).toBe("Hello");
      expect(normalizeFilenameTitle("___book_title___")).toBe("Book title");
      expect(normalizeFilenameTitle("---my-book---")).toBe("My book");
    });

    test("preserves special characters", () => {
      expect(normalizeFilenameTitle("Hello (World) [2024]")).toBe("Hello (World) [2024]");
      expect(normalizeFilenameTitle("Book #1")).toBe("Book #1");
    });

    test("handles unicode", () => {
      expect(normalizeFilenameTitle("Книга_автора")).toBe("Книга автора");
    });

    test("capitalizes first letter", () => {
      expect(normalizeFilenameTitle("hello_world")).toBe("Hello world");
      expect(normalizeFilenameTitle("test")).toBe("Test");
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
