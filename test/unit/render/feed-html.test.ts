import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import { renderHtml, formatFromMime } from "../../../src/render/feed-html.ts";
import type { FeedModel } from "../../../src/render/feed-model.ts";
import { allElements, byClass, flattenElements, parseHtml, type HtmlNode } from "../../helpers/html-query.ts";

const FEEDS_DIR = join(import.meta.dir, "../../fixtures/feeds");
const CASSETTES = [
  "root.xml",
  "nonfiction-cyrillic.xml",
  "cyrillic-book.xml",
  "large-folder.xml",
  "deep-nested.xml",
  "edge-cases.xml",
  "hostile.xml",
];

const readFeed = (name: string) => Bun.file(join(FEEDS_DIR, name)).text();
const stripDoctype = (html: string) => html.replace(/^<!DOCTYPE html>\s*/i, "");
const links = (roots: HtmlNode[]) => allElements(roots).filter((el) => el.tag === "a");
const documentIndex = (html: string, predicate: (el: HtmlNode) => boolean) => flattenElements(html).findIndex(predicate);

describe("renderHtml", () => {
  test("happy path: folder and book cards, breadcrumb home, title", async () => {
    // #given a non-root mixed feed
    const model = parseFeed(await readFeed("nonfiction-cyrillic.xml"));
    // #when rendered
    const roots = parseHtml(renderHtml(model));
    // #then the page title and heading carry the feed title
    expect(byClass(roots, "header__title")[0]?.text).toBe("Nonfiction");
    expect(allElements(roots).find((el) => el.tag === "title")?.text).toBe("Nonfiction");
    // and a home breadcrumb link appears for a non-root feed and targets the browser root
    expect(byClass(roots, "header__home")[0]?.attrs.href).toBe("/");
    // and every entry becomes a card of the right kind
    expect(byClass(roots, "card card--folder")).toHaveLength(1);
    expect(byClass(roots, "card card--book")).toHaveLength(5);
    // and the folder card links to the browser folder URL, never the reader feed.xml
    const hrefs = links(roots).map((a) => a.attrs.href);
    expect(hrefs).toContain("/nonfiction/finance/");
    expect(hrefs).not.toContain("/nonfiction/finance/feed.xml");
  });

  test("root feed omits the home breadcrumb link", async () => {
    const roots = parseHtml(renderHtml(parseFeed(await readFeed("root.xml"))));
    expect(byClass(roots, "header__home")).toHaveLength(0);
  });

  test("book without cover falls back to a text placeholder", async () => {
    const roots = parseHtml(renderHtml(parseFeed(await readFeed("edge-cases.xml"))));
    // the no-cover book renders its title in a <span>, not an <img>
    const spans = allElements(roots).filter((el) => el.tag === "span" && el.text === "Book Without Cover");
    expect(spans.length).toBeGreaterThan(0);
    // and no cover image is emitted for that title
    const imgs = allElements(roots).filter((el) => el.tag === "img" && el.attrs.alt === "Book Without Cover");
    expect(imgs).toHaveLength(0);
  });

  test("escapes markup in titles and metadata: renders as literal text, not elements", async () => {
    const roots = parseHtml(renderHtml(parseFeed(await readFeed("edge-cases.xml"))));
    // the title's angle brackets and ampersand survive as decoded text content
    const titleText = byClass(roots, "card__title").map((el) => el.text);
    expect(titleText).toContain("Tom & Jerry: <Adventures>");
    expect(allElements(roots).find((el) => el.tag === "title")?.text).toBe("Edge & Corner Cases");
    // and never as a live <Adventures> element
    expect(allElements(roots).some((el) => el.tag === "Adventures")).toBe(false);
  });

  test("book without author omits the author paragraph", async () => {
    const roots = parseHtml(renderHtml(parseFeed(await readFeed("edge-cases.xml"))));
    // #given the no-author book card (title "Tom & Jerry: <Adventures>")
    const card = byClass(roots, "card card--book").find((el) =>
      byClass([el], "card__title").some((t) => t.text === "Tom & Jerry: <Adventures>"),
    );
    expect(card).toBeDefined();
    // #then it has no card__description under its title
    expect(byClass([card!], "card__description")).toHaveLength(0);
  });

  test("popup ids are sequential and unique per book", async () => {
    const roots = parseHtml(renderHtml(parseFeed(await readFeed("large-folder.xml"))));
    const bookCount = byClass(roots, "card card--book").length;
    const popupIds = byClass(roots, "popup").map((el) => el.attrs.id);
    // ids run book-1..book-N with no gaps and no duplicates
    expect(popupIds).toEqual(Array.from({ length: bookCount }, (_, i) => `book-${i + 1}`));
    expect(new Set(popupIds).size).toBe(popupIds.length);
    // and each card's title links to its own popup id
    const cardTargets = links(roots)
      .map((a) => a.attrs.href)
      .filter((href) => href?.startsWith("#book-"));
    for (let i = 1; i <= bookCount; i++) expect(cardTargets).toContain(`#book-${i}`);
  });

  test("R7: references the bundled main.js and no unpkg runtime scripts", async () => {
    const roots = parseHtml(renderHtml(parseFeed(await readFeed("root.xml"))));
    const scripts = allElements(roots).filter((el) => el.tag === "script");
    expect(scripts.map((s) => s.attrs.src)).toEqual(["/static/main.js"]);
    expect(scripts.some((s) => (s.attrs.src ?? "").includes("unpkg.com"))).toBe(false);
    expect(byClass(roots, "books-grid")[0]?.attrs["data-element"]).toBe(".card__title a");
  });

  test("AE3: popup opens/closes with pure links and no JS hooks", async () => {
    // #given any book feed
    const roots = parseHtml(renderHtml(parseFeed(await readFeed("cyrillic-book.xml"))));
    // #then the card opens the popup via a hash link (:target), no checkbox/label
    expect(links(roots).some((a) => a.attrs.href === "#book-1")).toBe(true);
    expect(allElements(roots).some((el) => el.tag === "input" && el.attrs.type === "checkbox")).toBe(false);
    // and the close control is a plain anchor to "#" (closeable without JS)
    const close = byClass(roots, "popup__close-button")[0];
    expect(close?.tag).toBe("a");
    expect(close?.attrs.href).toBe("#");
    // and there are no inline JS event handlers on any element
    expect(
      allElements(roots)
        .flatMap((el) => Object.keys(el.attrs))
        .filter((k) => /^on/i.test(k)),
    ).toEqual([]);
  });

  test("popup→popup: distinct target ids let a second popup replace the first", async () => {
    // #given a feed with multiple books
    const html = renderHtml(parseFeed(await readFeed("large-folder.xml")));
    const roots = parseHtml(html);
    // #then each book targets its own id, so navigating #book-1 → #book-2 swaps :target
    const popupIds = byClass(roots, "popup").map((el) => el.attrs.id);
    expect(popupIds).toContain("book-1");
    expect(popupIds).toContain("book-2");
    expect(links(roots).some((a) => a.attrs.href === "#book-2")).toBe(true);
    // the second card's link precedes the first popup in document order (independent popups)
    const secondCardLink = documentIndex(html, (el) => el.tag === "a" && el.attrs.href === "#book-2");
    const firstPopup = documentIndex(html, (el) => el.attrs.class === "popup" && el.attrs.id === "book-1");
    expect(secondCardLink).toBeGreaterThan(firstPopup);
  });

  test("popup exposes metadata and per-format download buttons", async () => {
    const roots = parseHtml(renderHtml(parseFeed(await readFeed("nonfiction-cyrillic.xml"))));
    expect(byClass(roots, "popup__meta").length).toBeGreaterThan(0);
    const buttons = byClass(roots, "popup__download-btn");
    expect(buttons.length).toBeGreaterThan(0);
    const labels = buttons.map((b) => b.text);
    expect(labels).toContain("EPUB");
    expect(labels).toContain("FB2");
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
    const roots = parseHtml(renderHtml(model));
    expect(byClass(roots, "popup__meta")).toHaveLength(0);
    expect(byClass(roots, "popup__downloads")).toHaveLength(0);
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
