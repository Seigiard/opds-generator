import { describe, test, expect } from "bun:test";
import {
  createXmlParser,
  decodeEntities,
  getString,
  getFirstString,
  getStringArray,
  cleanDescription,
  parseDate,
} from "../../../src/formats/utils.ts";

describe("formats/utils", () => {
  describe("decodeEntities", () => {
    test("decodes common HTML entities", () => {
      expect(decodeEntities("&lt;tag&gt;")).toBe("<tag>");
      expect(decodeEntities("&amp;")).toBe("&");
      expect(decodeEntities("&quot;quoted&quot;")).toBe('"quoted"');
      expect(decodeEntities("&apos;single&apos;")).toBe("'single'");
    });

    test("decodes numeric entities", () => {
      expect(decodeEntities("&#65;")).toBe("A");
      expect(decodeEntities("&#97;")).toBe("a");
      expect(decodeEntities("&#1040;")).toBe("А"); // Cyrillic А
    });

    test("decodes hex entities", () => {
      expect(decodeEntities("&#x41;")).toBe("A");
      expect(decodeEntities("&#x61;")).toBe("a");
      expect(decodeEntities("&#xA9;")).toBe("©");
      expect(decodeEntities("&#XA9;")).toBe("©"); // uppercase X
    });

    test("handles multiple entities", () => {
      expect(decodeEntities("&lt;a&gt;&amp;&lt;b&gt;")).toBe("<a>&<b>");
    });

    test("preserves text without entities", () => {
      expect(decodeEntities("Hello World")).toBe("Hello World");
    });

    test("handles mixed content", () => {
      expect(decodeEntities("Price: &lt;$100 &amp; &#x3E;$50")).toBe("Price: <$100 & >$50");
    });
  });

  describe("getString", () => {
    test("returns string as-is (trimmed)", () => {
      expect(getString("hello")).toBe("hello");
      expect(getString("  hello  ")).toBe("hello");
    });

    test("decodes entities in string", () => {
      expect(getString("&lt;tag&gt;")).toBe("<tag>");
    });

    test("extracts #text from object", () => {
      expect(getString({ "#text": "content" })).toBe("content");
      expect(getString({ "#text": "  spaced  " })).toBe("spaced");
    });

    test("returns undefined for non-string/object", () => {
      expect(getString(null)).toBeUndefined();
      expect(getString(undefined)).toBeUndefined();
      expect(getString(123)).toBeUndefined();
      expect(getString([])).toBeUndefined();
    });

    test("returns undefined for empty object without #text", () => {
      expect(getString({})).toBeUndefined();
      expect(getString({ other: "value" })).toBeUndefined();
    });
  });

  describe("getFirstString", () => {
    test("returns first element of array", () => {
      expect(getFirstString(["first", "second"])).toBe("first");
    });

    test("handles single value (not array)", () => {
      expect(getFirstString("single")).toBe("single");
    });

    test("returns undefined for empty array", () => {
      expect(getFirstString([])).toBeUndefined();
    });

    test("handles array of objects with #text", () => {
      expect(getFirstString([{ "#text": "content" }])).toBe("content");
    });

    test("returns undefined for null/undefined", () => {
      expect(getFirstString(null)).toBeUndefined();
      expect(getFirstString(undefined)).toBeUndefined();
    });
  });

  describe("getStringArray", () => {
    test("converts array of strings", () => {
      expect(getStringArray(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    });

    test("wraps single string in array", () => {
      expect(getStringArray("single")).toEqual(["single"]);
    });

    test("filters out non-string values", () => {
      expect(getStringArray(["valid", null, "also valid"])).toEqual(["valid", "also valid"]);
    });

    test("handles array of objects with #text", () => {
      expect(getStringArray([{ "#text": "a" }, { "#text": "b" }])).toEqual(["a", "b"]);
    });

    test("returns undefined for null/undefined", () => {
      expect(getStringArray(null)).toBeUndefined();
      expect(getStringArray(undefined)).toBeUndefined();
    });

    test("returns undefined for array with only non-strings", () => {
      expect(getStringArray([null, undefined, 123])).toBeUndefined();
    });

    test("trims and decodes entities", () => {
      expect(getStringArray(["  spaced  ", "&lt;tag&gt;"])).toEqual(["spaced", "<tag>"]);
    });
  });

  describe("cleanDescription", () => {
    test("removes HTML tags", () => {
      expect(cleanDescription("<p>Hello</p>")).toBe("Hello");
      expect(cleanDescription("<b>Bold</b> and <i>italic</i>")).toBe("Bold and italic");
    });

    test("normalizes whitespace", () => {
      expect(cleanDescription("multiple   spaces")).toBe("multiple spaces");
      expect(cleanDescription("line\nbreaks\ttabs")).toBe("line breaks tabs");
    });

    test("trims leading/trailing whitespace", () => {
      expect(cleanDescription("  padded  ")).toBe("padded");
    });

    test("handles complex HTML", () => {
      expect(cleanDescription('<div class="desc"><p>Text</p></div>')).toBe("Text");
    });

    test("returns undefined for empty/whitespace-only result", () => {
      expect(cleanDescription("")).toBeUndefined();
      expect(cleanDescription("   ")).toBeUndefined();
      expect(cleanDescription("<br/><br/>")).toBeUndefined();
    });

    test("returns undefined for undefined input", () => {
      expect(cleanDescription(undefined)).toBeUndefined();
    });

    test("handles self-closing tags", () => {
      expect(cleanDescription("Line<br/>break")).toBe("Linebreak");
      expect(cleanDescription("Line <br/> break")).toBe("Line break");
    });
  });

  describe("parseDate", () => {
    test("extracts year and month", () => {
      expect(parseDate("2024-03-15")).toBe("2024-03");
      expect(parseDate("2024-12")).toBe("2024-12");
    });

    test("extracts year only", () => {
      expect(parseDate("2024")).toBe("2024");
    });

    test("ignores day and beyond", () => {
      expect(parseDate("2024-03-15T10:30:00Z")).toBe("2024-03");
    });

    test("returns undefined for invalid format", () => {
      expect(parseDate("invalid")).toBeUndefined();
      expect(parseDate("03-2024")).toBeUndefined();
      expect(parseDate("24-03-15")).toBeUndefined();
    });

    test("returns undefined for undefined/empty input", () => {
      expect(parseDate(undefined)).toBeUndefined();
      expect(parseDate("")).toBeUndefined();
    });
  });

  describe("createXmlParser", () => {
    test("creates parser that treats specified elements as arrays", () => {
      const parser = createXmlParser(["item"]);
      const result = parser.parse("<root><item>single</item></root>");
      expect(Array.isArray(result.root.item)).toBe(true);
    });

    test("removes namespace prefixes", () => {
      const parser = createXmlParser([]);
      const result = parser.parse('<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Test</dc:title>');
      expect(result.title).toBe("Test");
    });

    test("uses @_ prefix for attributes", () => {
      const parser = createXmlParser([]);
      const result = parser.parse('<link href="http://example.com"/>');
      expect(result.link["@_href"]).toBe("http://example.com");
    });
  });
});
