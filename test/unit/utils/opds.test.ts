import { describe, test, expect } from "bun:test";
import { stripXmlDeclaration, naturalSort } from "../../../src/utils/opds.ts";

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
});
