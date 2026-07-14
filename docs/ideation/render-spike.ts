/* Spike for ideation idea #1: render index.html next to every feed.xml in /data.
   Markup mirrors layout.xsl BEM classes so production /static/style.css applies.
   Folders link to directory URLs (browser graph), not feed.xml (reader graph). */
import { XMLParser } from "fast-xml-parser";
import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

const DATA = process.argv[2] ?? "data";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "entry" || name === "link" || name === "dc:subject",
});

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const FORMAT: [RegExp, string][] = [
  [/epub/, "EPUB"],
  [/pdf/, "PDF"],
  [/fb2|fictionbook/, "FB2"],
  [/mobi/, "MOBI"],
  [/azw/, "AZW3"],
  [/djvu/, "DJVU"],
  [/comicbook|cbz|cbr|7z|tar/, "Comic"],
  [/text\/plain/, "TXT"],
];
const fmt = (type = "") => FORMAT.find(([re]) => re.test(type))?.[1] ?? "Download";

type Link = { "@_rel"?: string; "@_href"?: string; "@_type"?: string };
const links = (o: any): Link[] => (o?.link ?? []) as Link[];
const rel = (o: any, r: string) => links(o).find((l) => l["@_rel"] === r);

function renderEntry(e: any): string {
  const title = esc(e.title);
  const sub = rel(e, "subsection");
  if (sub) {
    const dirHref = (sub["@_href"] ?? "").replace(/feed\.xml$/, "");
    return `<div><article class="card card--folder">
      ${`<div class="book" aria-hidden="true"><div class="book__cover"><span>${title}</span></div></div>`.repeat(3)}
      <div class="card__info"><h3 class="card__title"><a href="${esc(dirHref)}">${title}</a></h3>
      ${e.summary ? `<p>${esc(e.summary)}</p>` : ""}</div></article></div>`;
  }
  const thumb = rel(e, "http://opds-spec.org/image/thumbnail");
  const acq = links(e).filter((l) => (l["@_rel"] ?? "").includes("acquisition"));
  return `<div><article class="card card--book">
    <div class="book" aria-hidden="true"><div class="book__cover">
      ${thumb ? `<img src="${esc(thumb["@_href"])}" alt="${title}" loading="lazy"/>` : `<span>${title}</span>`}
    </div></div>
    <div class="card__info"><h3 class="card__title">${title}</h3>
    ${e.author?.name ? `<p>${esc(e.author.name)}</p>` : ""}
    <p>${acq.map((l) => `<a class="popup__download-btn" href="${esc(l["@_href"])}">${fmt(l["@_type"])}</a>`).join(" ")}</p>
    </div></article></div>`;
}

function renderFeed(xml: string): string {
  const feed = parser.parse(xml).feed;
  const title = esc(feed.title);
  const start = rel(feed, "start")?.["@_href"];
  const self = rel(feed, "self")?.["@_href"];
  const isRoot = !start || start === self;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${title}</title><link rel="stylesheet" href="/static/style.css"/></head><body>
<header class="header"><div class="header__left"><nav class="header__breadcrumb">
${isRoot ? "" : `<a class="header__home" href="/" aria-label="Home"><svg xmlns="http://www.w3.org/2000/svg" class="header__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg></a><span class="header__separator" aria-hidden="true">›</span><span class="header__breadcrumb-text">${title}</span>`}
</nav><h1 class="header__title">${title}</h1></div></header>
<main class="books-grid">${(feed.entry ?? []).map(renderEntry).join("\n")}</main>
</body></html>`;
}

let count = 0;
function walk(dir: string) {
  const feedPath = join(dir, "feed.xml");
  let hasFeed = false;
  try {
    hasFeed = lstatSync(feedPath).isFile();
  } catch {}
  if (hasFeed) {
    Bun.write(join(dir, "index.html"), renderFeed(require("node:fs").readFileSync(feedPath, "utf8")));
    count++;
  }
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) walk(p);
  }
}
walk(DATA);
console.log(`rendered ${count} index.html`);
