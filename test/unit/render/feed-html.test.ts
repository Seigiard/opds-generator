import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import { renderHtml, formatFromMime } from "../../../src/render/feed-html.ts";
import type { FeedModel } from "../../../src/render/feed-model.ts";

const FEEDS_DIR = join(import.meta.dir, "../../fixtures/feeds");
const CASSETTES = ["root.xml", "nonfiction-cyrillic.xml", "cyrillic-book.xml", "large-folder.xml", "deep-nested.xml", "edge-cases.xml"];

const readFeed = (name: string) => Bun.file(join(FEEDS_DIR, name)).text();
const stripDoctype = (html: string) => html.replace(/^<!DOCTYPE html>\s*/i, "");
const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("renderHtml", () => {
  test("happy path: folder and book cards, breadcrumb home, title", async () => {
    // #given a non-root mixed feed
    const model = parseFeed(await readFeed("nonfiction-cyrillic.xml"));
    // #when rendered
    const html = renderHtml(model);
    // #then the page title and heading are present
    expect(html).toContain("<title>Nonfiction</title>");
    expect(html).toContain('<h1 class="header__title">Nonfiction</h1>');
    // and a home breadcrumb link appears for a non-root feed
    expect(html).toContain('class="header__home"');
    // and every entry becomes a card
    expect(countOccurrences(html, 'class="card card--folder"')).toBe(1);
    expect(countOccurrences(html, 'class="card card--book"')).toBe(5);
    // and the folder card links to the folder URL
    expect(html).toContain('<a href="/nonfiction/finance/feed.xml">');
  });

  test("root feed omits the home breadcrumb link", async () => {
    const model = parseFeed(await readFeed("root.xml"));
    const html = renderHtml(model);
    expect(html).not.toContain('class="header__home"');
  });

  test("book without cover falls back to a text placeholder", async () => {
    const model = parseFeed(await readFeed("edge-cases.xml"));
    const html = renderHtml(model);
    // the no-cover book renders its title in a <span>, not an <img>
    expect(html).toContain("<span>Book Without Cover</span>");
  });

  test("escapes ampersand and angle brackets in titles and metadata", async () => {
    const model = parseFeed(await readFeed("edge-cases.xml"));
    const html = renderHtml(model);
    expect(html).toContain("Tom &amp; Jerry: &lt;Adventures&gt;");
    expect(html).toContain("<title>Edge &amp; Corner Cases</title>");
    expect(html).not.toContain("<Adventures>");
  });

  test("book without author omits the author paragraph", async () => {
    const model = parseFeed(await readFeed("edge-cases.xml"));
    const html = renderHtml(model);
    // the no-author book has no card__description under its title
    const bookBlock = html.slice(html.indexOf("Tom &amp; Jerry"));
    expect(bookBlock.slice(0, 200)).not.toContain("card__description");
  });

  test("popup ids are sequential and unique per book", async () => {
    const model = parseFeed(await readFeed("large-folder.xml"));
    const html = renderHtml(model);
    const bookCount = countOccurrences(html, 'class="card card--book"');
    for (let i = 1; i <= bookCount; i++) {
      expect(html).toContain(`id="book-${i}"`);
      expect(html).toContain(`href="#book-${i}"`);
    }
    // no duplicate popup ids
    expect(countOccurrences(html, 'id="book-1"')).toBe(1);
  });

  test("R7: references the bundled main.js and no unpkg runtime scripts", async () => {
    const html = renderHtml(parseFeed(await readFeed("root.xml")));
    expect(html).toContain('<script src="/static/main.js"></script>');
    expect(html).not.toContain("unpkg.com");
    expect(html).toContain('data-element=".card__title a"');
  });

  test("AE3: popup opens/closes with pure links and no JS hooks", async () => {
    // #given any book feed
    const html = renderHtml(parseFeed(await readFeed("cyrillic-book.xml")));
    // #then the card opens the popup via a hash link (:target), no checkbox/label
    expect(html).toContain('href="#book-1"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("popup-trigger");
    // and the close control is a plain anchor to "#" (closeable without JS)
    expect(html).toContain('<a class="popup__close-button" href="#">');
    // and there are no inline JS event handlers
    expect(html).not.toContain("onclick");
  });

  test("popup→popup: distinct target ids let a second popup replace the first", async () => {
    // #given a feed with multiple books
    const html = renderHtml(parseFeed(await readFeed("large-folder.xml")));
    // #then each book targets its own id, so navigating #book-1 → #book-2 swaps :target
    expect(html).toContain('id="book-1"');
    expect(html).toContain('id="book-2"');
    expect(html).toContain('href="#book-2"');
    // the second card's link precedes the first popup's close in document order (independent popups)
    expect(html.indexOf('href="#book-2"')).toBeGreaterThan(html.indexOf('id="book-1"'));
  });

  test("popup exposes metadata and per-format download buttons", async () => {
    const model = parseFeed(await readFeed("nonfiction-cyrillic.xml"));
    const html = renderHtml(model);
    expect(html).toContain('class="popup__meta"');
    expect(html).toContain('class="popup__download-btn"');
    expect(html).toContain(">EPUB</a>");
    expect(html).toContain(">FB2</a>");
  });

  test("omits empty popup sections when no metadata present", () => {
    // #given a book with no dc:* fields and no acquisitions
    const model: FeedModel = {
      id: "urn:opds:catalog:x",
      title: "X",
      updated: "2026-01-01T00:00:00.000Z",
      kind: "acquisition",
      selfHref: "/x/feed.xml",
      startHref: "/feed.xml",
      entries: [{ xml: "<entry/>", kind: "book", id: "b", title: "Bare Book" }],
    };
    const html = renderHtml(model);
    expect(html).not.toContain("popup__meta");
    expect(html).not.toContain("popup__downloads");
  });

  for (const name of CASSETTES) {
    test(`renders ${name} to well-formed markup`, async () => {
      const html = renderHtml(parseFeed(await readFeed(name)));
      const result = XMLValidator.validate(stripDoctype(html));
      expect(result).toBe(true);
    });
  }
});

describe("formatFromMime", () => {
  test.each([
    ["application/epub+zip", "EPUB"],
    ["application/pdf", "PDF"],
    ["application/x-fictionbook+xml", "FB2"],
    ["application/x-mobipocket-ebook", "MOBI"],
    ["application/x-mobi8-ebook", "MOBI"],
    ["some-azw-format", "AZW3"],
    ["image/vnd.djvu", "DJVU"],
    ["application/vnd.comicbook+zip", "Comic"],
    ["text/plain", "TXT"],
    ["application/zip", "Download"],
  ])("maps %s to %s", (mime, expected) => {
    expect(formatFromMime(mime)).toBe(expected);
  });
});
