import { describe, test, expect } from "bun:test";
import { buildFeedModel, entryFromFragment } from "../../../src/render/feed-model.ts";
import { renderXml } from "../../../src/render/feed-xml.ts";

const FIXED_UPDATED = "2026-01-01T00:00:00.000Z";

const BOOK_FRAGMENT = `<entry>
  <id>urn:opds:book:manual-test.pdf</id>
  <title>Test Book</title>
  <updated>2026-01-08T04:52:36.379Z</updated>
  <dc:issued>2025</dc:issued>
  <dc:format>PDF</dc:format>
  <dc:extent>3 pages</dc:extent>
  <dc:subject>test</dc:subject>
  <author>
    <name>Test Author</name>
  </author>
  <content type="text">90.1 KB</content>
  <link rel="http://opds-spec.org/image" href="/manual-test.pdf/cover.jpg" type="image/jpeg"/>
  <link rel="http://opds-spec.org/image/thumbnail" href="/manual-test.pdf/thumb.jpg" type="image/jpeg"/>
  <link rel="http://opds-spec.org/acquisition/open-access" href="/manual-test.pdf/file" type="application/pdf"/>
</entry>`;

const FOLDER_FRAGMENT = `<entry>
  <id>urn:opds:catalog:comics</id>
  <title>Comics</title>
  <updated>2026-07-14T05:25:47.546Z</updated>
  <summary type="text">🗂 2</summary>
  <link rel="subsection" href="/comics/feed.xml" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
</entry>`;

function rootModel(fragments: string[]) {
  return buildFeedModel({
    id: "urn:opds:catalog:root",
    title: "Catalog",
    updated: FIXED_UPDATED,
    kind: "navigation",
    selfHref: "/feed.xml",
    startHref: "/feed.xml",
    fragments,
  });
}

describe("renderXml", () => {
  test("emits xml declaration with no stylesheet PI (post-flip)", () => {
    // #given a model with fixed clock
    // #when rendered
    const xml = renderXml(rootModel([FOLDER_FRAGMENT]));
    // #then the declaration leads and no XSLT stylesheet PI is present
    const lines = xml.split("\n");
    expect(lines[0]).toBe('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).not.toContain("xml-stylesheet");
    expect(xml).not.toContain("layout.xsl");
  });

  test("splices entry fragments verbatim before closing tag", () => {
    const xml = renderXml(rootModel([FOLDER_FRAGMENT, BOOK_FRAGMENT]));
    expect(xml).toContain(FOLDER_FRAGMENT);
    expect(xml).toContain(BOOK_FRAGMENT);
    expect(xml.trimEnd().endsWith("</feed>")).toBe(true);
  });

  test("carries feed metadata: id, title, updated, self and start links", () => {
    const xml = renderXml(rootModel([]));
    expect(xml).toContain("<id>urn:opds:catalog:root</id>");
    expect(xml).toContain("<title>Catalog</title>");
    expect(xml).toContain(`<updated>${FIXED_UPDATED}</updated>`);
    expect(xml).toContain('<link rel="self" href="/feed.xml"');
    expect(xml).toContain('<link rel="start" href="/feed.xml"');
    expect(xml).toContain("kind=navigation");
  });

  test("is deterministic for a fixed clock", () => {
    const model = rootModel([FOLDER_FRAGMENT]);
    expect(renderXml(model)).toBe(renderXml(model));
  });

  test("fragment text with $-substitution sequences is spliced verbatim", () => {
    // #given a title containing replace() substitution patterns
    const fragment = `<entry>
  <id>urn:opds:book:dollar</id>
  <title>Price $&amp; Value $' $\`</title>
</entry>`;
    // #when rendered
    const xml = renderXml(rootModel([fragment]));
    // #then the fragment survives unmangled
    expect(xml).toContain(fragment);
  });

  test("acquisition kind reflected in self link when hasBooks", () => {
    const model = buildFeedModel({
      id: "urn:opds:catalog:pdf",
      title: "Pdf",
      updated: FIXED_UPDATED,
      kind: "acquisition",
      selfHref: "/pdf/feed.xml",
      startHref: "/feed.xml",
      fragments: [BOOK_FRAGMENT],
    });
    const xml = renderXml(model);
    expect(xml).toContain('<link rel="self" href="/pdf/feed.xml"');
    expect(xml).toContain("kind=acquisition");
  });
});

describe("entryFromFragment", () => {
  test("parses a book entry's fields to match the fragment", () => {
    const entry = entryFromFragment(BOOK_FRAGMENT);
    expect(entry.kind).toBe("book");
    expect(entry.id).toBe("urn:opds:book:manual-test.pdf");
    expect(entry.title).toBe("Test Book");
    expect(entry.author).toBe("Test Author");
    expect(entry.issued).toBe("2025");
    expect(entry.format).toBe("PDF");
    expect(entry.content).toBe("90.1 KB");
    expect(entry.subjects).toEqual(["test"]);
    expect(entry.cover).toBe("/manual-test.pdf/cover.jpg");
    expect(entry.thumbnail).toBe("/manual-test.pdf/thumb.jpg");
    expect(entry.acquisitions).toEqual([{ href: "/manual-test.pdf/file", type: "application/pdf" }]);
    expect(entry.xml).toBe(BOOK_FRAGMENT);
  });

  test("classifies a subsection entry as a folder with href and summary", () => {
    const entry = entryFromFragment(FOLDER_FRAGMENT);
    expect(entry.kind).toBe("folder");
    expect(entry.title).toBe("Comics");
    expect(entry.href).toBe("/comics/feed.xml");
    expect(entry.summary).toBe("🗂 2");
    expect(entry.acquisitions).toBeUndefined();
    expect(entry.cover).toBeUndefined();
  });

  test("is total: malformed fragment degrades fields but preserves verbatim xml", () => {
    // #given a fragment fast-xml-parser cannot handle
    const malformed = "<entry><title>broken << & unclosed";
    // #when parsed
    expect(() => entryFromFragment(malformed)).not.toThrow();
    const entry = entryFromFragment(malformed);
    // #then the verbatim xml survives so renderXml (and feed.xml) is unaffected
    expect(entry.xml).toBe(malformed);
    expect(renderXml(rootModel([malformed]))).toContain(malformed);
  });

  test("multiple dc:subject values parse to an array", () => {
    const fragment = `<entry>
  <id>urn:opds:book:x</id>
  <title>Multi</title>
  <dc:subject>fiction</dc:subject>
  <dc:subject>classic</dc:subject>
  <link rel="http://opds-spec.org/acquisition/open-access" href="/x/file" type="application/epub+zip"/>
</entry>`;
    const entry = entryFromFragment(fragment);
    expect(entry.subjects).toEqual(["fiction", "classic"]);
  });
});
