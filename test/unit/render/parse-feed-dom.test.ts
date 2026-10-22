import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Window } from "happy-dom";
import { parseFeed } from "../../../src/render/parse-feed.ts";

const FEEDS_DIR = join(import.meta.dir, "../../fixtures/feeds");

const PARSER_MODULE = "../../../ui/gridnav/parse-feed-dom.ts";

describe("parseFeedDom", () => {
  test("matches the server parser for every feed fixture", async () => {
    // #given every catalogue feed cassette and a browser DOMParser
    const names = (await readdir(FEEDS_DIR)).filter((name) => name.endsWith(".xml")).sort();
    const xmls = await Promise.all(names.map((name) => Bun.file(join(FEEDS_DIR, name)).text()));
    const originalDomParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
    Object.defineProperty(globalThis, "DOMParser", {
      configurable: true,
      writable: true,
      value: new Window().DOMParser,
    });

    try {
      // #when the browser parser consumes the same source as the server parser
      const { parseFeedDom } = await import(PARSER_MODULE);
      const actual = xmls.map((xml) => parseFeedDom(xml));
      const expected = xmls.map((xml) => parseFeed(xml));

      // #then every parsed model, including each verbatim entry fragment, is identical
      expect(actual).toEqual(expected);
    } finally {
      if (originalDomParser) {
        Object.defineProperty(globalThis, "DOMParser", originalDomParser);
      } else {
        Reflect.deleteProperty(globalThis, "DOMParser");
      }
    }
  });
});
