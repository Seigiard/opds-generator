import { describe, test, expect } from "bun:test";
import { stripXmlDeclaration, naturalSort, extractTitle, extractAuthor } from "../../../src/utils/opds.ts";

describe("utils/opds", () => {
  describe("stripXmlDeclaration", () => {
    test("removes standard XML declaration", () => {
      const xml = '<?xml version="1.0" encoding="utf-8"?><feed>content</feed>';
      expect(stripXmlDeclaration(xml)).toBe("<feed>content</feed>");
    });

    test("removes declaration with single quotes", () => {
      const xml = "<?xml version='1.0' encoding='utf-8'?><feed/>";
      expect(stripXmlDeclaration(xml)).toBe("<feed/>");
    });

    test("removes declaration with newline", () => {
      const xml = '<?xml version="1.0"?>\n<entry>test</entry>';
      expect(stripXmlDeclaration(xml)).toBe("<entry>test</entry>");
    });

    test("handles multiple declarations (invalid but robust)", () => {
      const xml = '<?xml version="1.0"?><?xml version="1.1"?><root/>';
      expect(stripXmlDeclaration(xml)).toBe("<root/>");
    });

    test("returns unchanged if no declaration", () => {
      const xml = "<feed><entry/></feed>";
      expect(stripXmlDeclaration(xml)).toBe("<feed><entry/></feed>");
    });

    test("trims whitespace around result", () => {
      const xml = '<?xml version="1.0"?>   \n  <feed/>  ';
      expect(stripXmlDeclaration(xml)).toBe("<feed/>");
    });
  });

  describe("naturalSort", () => {
    test("sorts strings alphabetically", () => {
      const items = ["banana", "apple", "cherry"];
      expect(items.sort(naturalSort)).toEqual(["apple", "banana", "cherry"]);
    });

    test("sorts numbers naturally (not lexicographically)", () => {
      const items = ["item10", "item2", "item1", "item20"];
      expect(items.sort(naturalSort)).toEqual(["item1", "item2", "item10", "item20"]);
    });

    test("handles cyrillic characters", () => {
      const items = ["Яблоко", "Апельсин", "Банан"];
      const sorted = items.sort(naturalSort);
      expect(sorted[0]).toBe("Апельсин");
      expect(sorted[1]).toBe("Банан");
      expect(sorted[2]).toBe("Яблоко");
    });

    test("handles mixed content", () => {
      const items = ["Chapter 10", "Chapter 2", "Chapter 1"];
      expect(items.sort(naturalSort)).toEqual(["Chapter 1", "Chapter 2", "Chapter 10"]);
    });

    test("is case-insensitive", () => {
      const items = ["Apple", "banana", "CHERRY"];
      const sorted = items.sort(naturalSort);
      expect(sorted).toEqual(["Apple", "banana", "CHERRY"]);
    });

    test("handles file-like names with extensions", () => {
      const items = ["book10.epub", "book2.epub", "book1.epub"];
      expect(items.sort(naturalSort)).toEqual(["book1.epub", "book2.epub", "book10.epub"]);
    });
  });

  describe("extractTitle", () => {
    test("extracts title from simple entry", () => {
      const xml = "<entry><title>My Book Title</title></entry>";
      expect(extractTitle(xml)).toBe("My Book Title");
    });

    test("extracts title from multiline XML", () => {
      const xml = `<entry>
        <title>
          Multiline Title
        </title>
      </entry>`;
      expect(extractTitle(xml)).toBe("Multiline Title");
    });

    test("decodes HTML entities", () => {
      const xml = "<entry><title>Books &amp; Authors</title></entry>";
      expect(extractTitle(xml)).toBe("Books & Authors");
    });

    test("decodes all standard entities", () => {
      const xml = "<entry><title>&lt;tag&gt; &quot;quoted&quot; &apos;apostrophe&apos;</title></entry>";
      expect(extractTitle(xml)).toBe("<tag> \"quoted\" 'apostrophe'");
    });

    test("returns empty string for missing title", () => {
      const xml = "<entry><id>123</id></entry>";
      expect(extractTitle(xml)).toBe("");
    });

    test("returns empty string for empty title", () => {
      const xml = "<entry><title></title></entry>";
      expect(extractTitle(xml)).toBe("");
    });

    test("handles title with attributes", () => {
      const xml = '<entry><title type="text">Attributed Title</title></entry>';
      expect(extractTitle(xml)).toBe("Attributed Title");
    });

    test("handles Cyrillic titles", () => {
      const xml = "<entry><title>Колір повітря</title></entry>";
      expect(extractTitle(xml)).toBe("Колір повітря");
    });

    test("handles mixed content with entities", () => {
      const xml = "<entry><title>Чому ми досі живі? Путівник &amp; Поради</title></entry>";
      expect(extractTitle(xml)).toBe("Чому ми досі живі? Путівник & Поради");
    });
  });

  describe("extractAuthor", () => {
    test("extracts author name from entry", () => {
      const xml = "<entry><author><name>Test Author</name></author></entry>";
      expect(extractAuthor(xml)).toBe("Test Author");
    });

    test("returns undefined for missing author", () => {
      const xml = "<entry><title>No Author Book</title></entry>";
      expect(extractAuthor(xml)).toBeUndefined();
    });

    test("handles whitespace around name", () => {
      const xml = `<entry><author>
        <name>  Spaced Author  </name>
      </author></entry>`;
      expect(extractAuthor(xml)).toBe("Spaced Author");
    });

    test("decodes HTML entities", () => {
      const xml = "<entry><author><name>Author &amp; Co.</name></author></entry>";
      expect(extractAuthor(xml)).toBe("Author & Co.");
    });

    test("handles Cyrillic names", () => {
      const xml = "<entry><author><name>Иванов Иван</name></author></entry>";
      expect(extractAuthor(xml)).toBe("Иванов Иван");
    });

    test("returns undefined for empty name", () => {
      const xml = "<entry><author><name></name></author></entry>";
      expect(extractAuthor(xml)).toBeUndefined();
    });

    test("returns undefined for author without name element", () => {
      const xml = "<entry><author><uri>http://example.com</uri></author></entry>";
      expect(extractAuthor(xml)).toBeUndefined();
    });
  });
});
