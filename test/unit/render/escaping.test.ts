import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import { renderCover, renderDownloads, renderHtml, renderMeta } from "../../../src/render/feed-html.ts";
import type { FeedEntry, FeedModel } from "../../../src/render/feed-model.ts";
import { byClass, collectAttributes, flattenElements, parseHtml } from "../../helpers/html-query.ts";

const FEEDS_DIR = join(import.meta.dir, "../../fixtures/feeds");

const ALL_CASSETTES = [
  "root.xml",
  "nonfiction-cyrillic.xml",
  "cyrillic-book.xml",
  "large-folder.xml",
  "deep-nested.xml",
  "edge-cases.xml",
  "hostile.xml",
];

const readFeed = (name: string) => Bun.file(join(FEEDS_DIR, name)).text();

const renderCassette = async (name: string) => renderHtml(parseFeed(await readFeed(name)));

const stripDoctype = (html: string) => html.replace(/^<!DOCTYPE html>\s*/i, "");

const hrefLikeAttrs = (html: string) => collectAttributes(html).filter((a) => a.name === "href" || a.name === "src");

describe("escaping contract (hostile cassette)", () => {
  test("zero-JS invariant: no on*= attributes in any cassette output", async () => {
    // #given every cassette, including the hostile one
    for (const name of ALL_CASSETTES) {
      const html = await renderCassette(name);
      // #then the output must first be well-formed — a swallowed attribute breakout would
      // otherwise vanish from the parsed tree and pass the handler query silently
      expect(XMLValidator.validate(stripDoctype(html)), `${name} must be well-formed`).toBe(true);
      // and no rendered element carries an inline event-handler attribute
      const handlers = collectAttributes(html).filter((a) => /^on/i.test(a.name));
      expect(handlers, `${name} must have no on* attributes`).toEqual([]);
    }
  });

  test("zero-JS invariant: the only <script> is the bundled main.js, popup stays :target-only", async () => {
    // #given the hostile cassette injects </script> in title, author, and summary
    const html = await renderCassette("hostile.xml");
    const scripts = flattenElements(html).filter((el) => el.tag === "script");
    // #then no data-derived <script> boundary is produced — exactly the progressive-enhancement bundle
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.attrs.src).toBe("/static/main.js");
    expect(scripts[0]?.text).toBe("");
    // and the popup close control is a pure :target anchor, no checkbox/JS trigger
    expect(html).toContain('<a class="popup__close-button" href="#">');
    expect(html).not.toContain('type="checkbox"');
  });

  test("R2: markup-injection probes never become live elements", async () => {
    // #given <b>/<i> tags embedded in title and isPartOf, and </style> in a summary
    const html = await renderCassette("hostile.xml");
    const injected = flattenElements(html).filter((el) => ["b", "i", "style"].includes(el.tag));
    // #then none of them materialize as elements — they survive only as escaped text
    expect(injected).toEqual([]);
    expect(html).not.toContain("<b>bold</b>");
  });

  test("AE2: a source ampersand renders single-escaped, never &amp;amp;", async () => {
    // #given titles/summaries whose logical text contains a single &
    const html = await renderCassette("hostile.xml");
    // #then the ampersand is escaped exactly once
    expect(html).toContain("Ampersand &amp; entity test");
    expect(html).toContain("Legit summary with a &amp; ampersand.");
    expect(html).not.toContain("&amp;amp;");
  });

  test('" onmouseover=alert(1) in a title cannot break out of the alt attribute', async () => {
    // #given a title carrying a double-quote + event-handler payload
    const html = await renderCassette("hostile.xml");

    // #then it stays inside the alt attribute value; no onmouseover attribute exists
    const onmouseover = collectAttributes(html).filter((a) => a.name.toLowerCase() === "onmouseover");

    expect(onmouseover).toEqual([]);
  });

  test("newline in author keeps every cassette well-formed", async () => {
    // #given the hostile cassette has a literal newline inside an author name
    for (const name of ALL_CASSETTES) {
      const html = await renderCassette(name);
      // #then the rendered document stays well-formed markup
      expect(XMLValidator.validate(stripDoctype(html)), `${name} must be well-formed`).toBe(true);
    }
  });

  // Known-gap contract (KTD-2): red pre-swap, activated at the swap (U5).
  test("apostrophe escaping contract: ' in an attribute value renders as &#39;", async () => {
    // #given a title containing an apostrophe interpolated into the alt attribute
    const html = await renderCassette("hostile.xml");
    // #then the apostrophe is entity-encoded, not passed through raw
    expect(html).toContain("Tom&#39;s");
    expect(html).not.toMatch(/alt="Tom's/);
  });

  test("javascript: URLs are neutralized at all four href interpolation sites", async () => {
    // #given javascript: URLs in acquisition href, folder href, cover src, thumbnail src
    const html = await renderCassette("hostile.xml");

    // #then no href/src attribute survives with a javascript: scheme
    const dangerous = hrefLikeAttrs(html).filter((a) => a.value.toLowerCase().startsWith("javascript:"));

    expect(dangerous).toEqual([]);
  });
});

describe("exported components auto-escape and guard hrefs", () => {
  const bookEntry = (over: Partial<FeedEntry>): FeedEntry => ({
    xml: "<entry/>",
    kind: "book",
    id: "b",
    title: "T",
    ...over,
  });

  test("renderCover: neutralizes a javascript: src and escapes the alt apostrophe", () => {
    // #given a cover source with a dangerous scheme and an apostrophe in the title
    const cover = String(renderCover(bookEntry({ title: "O'Neil" }), "javascript:alert(1)", true));
    // #then the src is inert and the apostrophe is entity-encoded
    expect(cover).toContain('src="#"');
    expect(cover).not.toContain("javascript:");
    expect(cover).toContain('alt="O&#39;Neil"');
  });

  test("renderCover: passes a legit absolute path through untouched", () => {
    const cover = String(renderCover(bookEntry({ title: "Cover" }), "/data/book/thumb.jpg", false));
    expect(cover).toContain('src="/data/book/thumb.jpg"');
  });

  test("renderMeta: escapes quotes inside subject metadata", () => {
    const meta = String(renderMeta(bookEntry({ subjects: ['sci"fi', "kids"] })));
    expect(meta).toContain("sci&quot;fi, kids");
    expect(meta).not.toContain('sci"fi');
  });

  test("renderMeta: empty for an entry with no metadata", () => {
    expect(String(renderMeta(bookEntry({})))).toBe("");
  });

  test("renderDownloads: neutralizes a javascript: acquisition href, keeps the format label", () => {
    const downloads = String(
      renderDownloads(
        bookEntry({
          acquisitions: [{ href: "javascript:alert(1)", type: "application/epub+zip" }],
        }),
      ),
    );

    expect(downloads).toContain('href="#"');
    expect(downloads).not.toContain("javascript:");
    expect(downloads).toContain(">EPUB</a>");
  });

  test("renderDownloads: a hostile viewable acquisition emits no View link — the fragment never carries a scheme payload", () => {
    // #given viewable-format acquisitions with javascript:/data: hrefs
    for (const href of ["javascript:alert(1)", "data:text/html,<script>1</script>", "https://evil.example/x.epub"]) {
      const downloads = String(renderDownloads(bookEntry({ acquisitions: [{ href, type: "application/epub+zip" }] })));

      // #then no View link is rendered at all — only root-relative book paths reach the reader fragment
      expect(downloads).not.toContain("popup__view-btn");
      expect(downloads).not.toContain("read.html");
    }
  });

  test("renderDownloads: a legit root-relative viewable acquisition gets a safeHref-gated View link", () => {
    const downloads = String(
      renderDownloads(
        bookEntry({
          acquisitions: [{ href: "/hostile/preescaped.epub/file", type: "application/epub+zip" }],
        }),
      ),
    );

    expect(downloads).toContain('href="/static/read.html#/hostile/preescaped.epub/file"');
  });

  // Control-char obfuscation: browsers drop C0/DEL bytes before scheme resolution, reconstituting javascript:.
  // safeHref must strip them first, so the naive scheme regex cannot be split by an embedded tab/newline/CR.
  const obfuscated = [
    ["tab", "java\tscript:alert(1)"],
    ["newline", "java\nscript:alert(1)"],
    ["carriage-return", "java\rscript:alert(1)"],
    ["leading-null", " javascript:alert(1)"],
  ] as const;

  for (const [label, payload] of obfuscated) {
    test(`renderCover: neutralizes a ${label}-obfuscated javascript: src`, () => {
      const cover = String(renderCover(bookEntry({ title: "X" }), payload, true));
      expect(cover).toContain('src="#"');
      expect(cover.toLowerCase()).not.toContain("javascript:");
      expect(cover.toLowerCase()).not.toContain("script:alert");
    });

    test(`renderDownloads: neutralizes a ${label}-obfuscated javascript: acquisition href`, () => {
      const downloads = String(renderDownloads(bookEntry({ acquisitions: [{ href: payload, type: "application/epub+zip" }] })));

      expect(downloads).toContain('href="#"');
      expect(downloads.toLowerCase()).not.toContain("script:alert");
    });
  }
});

describe("renderHeader home link guards a hostile startHref", () => {
  const model = (startHref: string): FeedModel => ({
    id: "urn:x",
    title: "T",
    updated: "2026-01-01T00:00:00.000Z",
    kind: "acquisition",
    selfHref: "/x/feed.xml",
    startHref,
    entries: [],
  });

  test("plain javascript: startHref renders the home link inert", () => {
    const roots = parseHtml(renderHtml(model("javascript:alert(1)")));
    expect(byClass(roots, "header__home")[0]?.attrs.href).toBe("#");
  });

  test("control-char-obfuscated startHref renders the home link inert", () => {
    const roots = parseHtml(renderHtml(model("java\tscript:alert(1)")));
    const home = byClass(roots, "header__home")[0];
    expect(home?.attrs.href).toBe("#");
  });
});
