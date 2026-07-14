import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import { renderXml } from "../../../src/render/feed-xml.ts";

const FEEDS_DIR = join(import.meta.dir, "../../fixtures/feeds");
const REAL_CASSETTES = ["root.xml", "nonfiction-cyrillic.xml", "cyrillic-book.xml", "large-folder.xml", "deep-nested.xml"];

const readFeed = (name: string) => Bun.file(join(FEEDS_DIR, name)).text();
const normalizeUpdated = (xml: string) => xml.replace(/<updated>[^<]*<\/updated>/g, "<updated>X</updated>");
const stripStylesheetPi = (xml: string) => xml.replace(/^\s*<\?xml-stylesheet[^>]*\?>\n/m, "");

describe("parseFeed", () => {
  test("extracts feed metadata and entries from a real cassette", async () => {
    // #given a mixed folder+book acquisition feed with cyrillic content
    const xml = await readFeed("nonfiction-cyrillic.xml");
    // #when parsed
    const model = parseFeed(xml);
    // #then feed-level metadata is recovered
    expect(model.id).toBe("urn:opds:catalog:nonfiction");
    expect(model.title).toBe("Nonfiction");
    expect(model.kind).toBe("acquisition");
    expect(model.selfHref).toBe("/nonfiction/feed.xml");
    expect(model.startHref).toBe("/feed.xml");
    expect(model.entries).toHaveLength(6);
    // and the leading folder entry classifies as a folder
    expect(model.entries[0]?.kind).toBe("folder");
    expect(model.entries[0]?.title).toBe("Finance");
  });

  test("recovers dc:* fields, cyrillic author and isPartOf", async () => {
    const model = parseFeed(await readFeed("nonfiction-cyrillic.xml"));
    const cyrillic = model.entries.find((e) => e.title === "Хроники Сиалы");
    expect(cyrillic).toBeDefined();
    expect(cyrillic?.author).toBe("Алексей Юрьевич Пехов");
    expect(cyrillic?.isPartOf).toBe("Хроники Сиалы");
    expect(cyrillic?.language).toBe("ru");
    expect(cyrillic?.subjects).toEqual(["sf_fantasy"]);
  });

  test("decodes escaped ampersand in dc:subject", async () => {
    const model = parseFeed(await readFeed("nonfiction-cyrillic.xml"));
    const learning = model.entries.find((e) => e.title === "Learning Patterns");
    expect(learning?.subjects).toEqual(["Computers & Technology"]);
  });

  test("navigation feed without books parses as navigation kind", async () => {
    const model = parseFeed(await readFeed("deep-nested.xml"));
    expect(["navigation", "acquisition"]).toContain(model.kind);
    expect(model.entries.length).toBeGreaterThan(0);
  });

  for (const name of REAL_CASSETTES) {
    test(`flip diff: renderXml(parseFeed(${name})) equals source minus the stylesheet PI (modulo <updated>)`, async () => {
      // #given a legacy feed that still carries the XSLT stylesheet PI
      const source = await readFeed(name);
      expect(source).toContain("xml-stylesheet");
      // #when round-tripped through the model post-flip
      const rebuilt = renderXml(parseFeed(source));
      // #then the sole difference is the removed PI line (structure byte-preserved)
      expect(normalizeUpdated(rebuilt)).toBe(normalizeUpdated(stripStylesheetPi(source)));
      expect(rebuilt).not.toContain("xml-stylesheet");
    });
  }
});
