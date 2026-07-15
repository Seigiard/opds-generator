import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { FeedEntry, FeedModel } from "./feed-model.ts";

type Fragment = HtmlEscapedString | string;

/** Sync-narrowed hono/html tag: auto-escapes interpolated values. An async interpolation would make hono return a Promise — forbidden by R10, enforced here at runtime. */
const frag = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString => {
  const result = html(strings, ...values);
  if (result instanceof Promise) throw new Error("frag: async interpolation forbidden (R10)");
  return result;
};

/** Interleave fragments with a literal separator instead of `.join()`, which would strip the escaped marker (KTD-3). */
function interleave(items: Fragment[], separator: string): Fragment[] {
  return items.flatMap((item, i) => (i === 0 ? [item] : [separator, item]));
}

/** Reader links point at feed.xml; browsers need the folder URL nginx resolves to index.html. */
function browserHref(feedHref: string): string {
  const folderUrl = feedHref.replace(/feed\.xml$/, "");
  return folderUrl === "" ? "/" : folderUrl;
}

/**
 * Auto-escaping neutralizes markup, not schemes; drop anything but http(s)/relative/fragment to `#` (KTD-4, R11).
 * Strip ASCII control chars first: browsers ignore C0/DEL bytes when resolving a scheme, so `java\tscript:` would
 * reconstitute to `javascript:` after the naive scheme regex let it through raw.
 */
function safeHref(href: string): string {
  // oxlint-disable-next-line no-control-regex -- deliberate: strip C0/DEL bytes that browsers ignore during scheme resolution
  const trimmed = href.trim().replace(/[\u0000-\u001F\u007F]/g, "");
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (scheme) return scheme[1]!.toLowerCase() === "http" || scheme[1]!.toLowerCase() === "https" ? trimmed : "#";
  return trimmed;
}

export function formatFromMime(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("epub")) return "EPUB";
  if (t.includes("pdf")) return "PDF";
  if (t.includes("fb2") || t.includes("fictionbook")) return "FB2";
  if (t.includes("mobi")) return "MOBI";
  if (t.includes("azw")) return "AZW3";
  if (t.includes("djvu")) return "DJVU";
  if (t.includes("comicbook") || t.includes("cbz") || t.includes("cbr") || t.includes("7z") || t.includes("tar")) {
    return "Comic";
  }
  if (t.includes("text/plain")) return "TXT";
  return "Download";
}

const FAVICON_LINKS = frag`<link rel="icon" type="image/png" href="/static/favicon/favicon-96x96.png" sizes="96x96" />
    <link rel="icon" type="image/svg+xml" href="/static/favicon/favicon.svg" />
    <link rel="shortcut icon" href="/static/favicon/favicon.ico" />
    <link rel="apple-touch-icon" sizes="180x180" href="/static/favicon/apple-touch-icon.png" />
    <link rel="manifest" href="/static/favicon/site.webmanifest" />`;

export function renderHtml(model: FeedModel): string {
  let bookIndex = 0;
  const cards = interleave(
    model.entries.map((entry) => (entry.kind === "folder" ? renderFolder(entry) : renderBook(entry, ++bookIndex))),
    "\n",
  );

  return String(frag`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${model.title}</title>
    <link rel="stylesheet" href="/static/style.css" />
    ${FAVICON_LINKS}
  </head>
  <body>
    ${renderHeader(model)}
    <main class="books-grid" data-element=".card__title a">
${cards}
    </main>
    <script src="/static/main.js"></script>
  </body>
</html>
`);
}

function renderHeader(model: FeedModel): HtmlEscapedString {
  const isRoot = model.selfHref === model.startHref;
  const home = isRoot
    ? ""
    : frag`
        <a class="header__home" href="${safeHref(browserHref(model.startHref))}" aria-label="Home">
          <svg xmlns="http://www.w3.org/2000/svg" class="header__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
          </svg>
        </a>`;

  return frag`<header class="header">
      <div class="header__left">
        <nav class="header__breadcrumb">${home}
        </nav>
        <h1 class="header__title">${model.title}</h1>
      </div>
    </header>`;
}

export function renderCover(entry: FeedEntry, src: string | undefined, lazy: boolean): HtmlEscapedString {
  if (src) {
    const loading = lazy ? frag` loading="lazy"` : "";
    return frag`<img src="${safeHref(src)}" alt="${entry.title}"${loading} />`;
  }
  return frag`<span>${entry.title}</span>`;
}

function renderFolder(entry: FeedEntry): HtmlEscapedString {
  const href = safeHref(entry.href ? browserHref(entry.href) : "#");
  const shelf = frag`<div class="book" aria-hidden="true"><div class="book__cover"><span>${entry.title}</span></div></div>`;
  const stack = interleave([shelf, shelf, shelf], "\n        ");
  const description = entry.summary
    ? frag`
          <p class="card__description">${entry.summary}</p>`
    : "";

  return frag`      <div>
        <article class="card card--folder">
        ${stack}
        <div class="card__info">
          <h3 class="card__title"><a href="${href}">${entry.title}</a></h3>${description}
        </div>
        </article>
      </div>`;
}

function renderBook(entry: FeedEntry, index: number): HtmlEscapedString {
  const popupId = `book-${index}`;
  const author = entry.author
    ? frag`
          <p class="card__description">${entry.author}</p>`
    : "";
  const popupAuthor = entry.author
    ? frag`
                <p class="popup__author">${entry.author}</p>`
    : "";
  const popupDescription = entry.summary
    ? frag`
              <p class="popup__description">${entry.summary}</p>`
    : "";
  const cardCover = renderCover(entry, entry.thumbnail, true);
  const popupCover = renderCover(entry, entry.cover ?? entry.thumbnail, false);

  return frag`      <div>
        <article class="card card--book">
          <div class="book" aria-hidden="true">
            <div class="book__cover">${cardCover}</div>
          </div>
          <div class="card__info">
            <h3 class="card__title"><a href="#${popupId}">${entry.title}</a></h3>${author}
          </div>
        </article>
        <div class="popup" id="${popupId}">
          <div class="popup__content">
            <div class="popup__cover" aria-hidden="true">
              <div class="book"><div class="book__cover">${popupCover}</div></div>
            </div>
            <div class="popup__info">
              <a class="popup__close-button" href="#"><span>Close</span></a>
              <hgroup>
                <h2 class="popup__title">${entry.title}</h2>${popupAuthor}
              </hgroup>${popupDescription}
              <div class="popup__footer">${renderMeta(entry)}${renderDownloads(entry)}
              </div>
            </div>
          </div>
        </div>
      </div>`;
}

export function renderMeta(entry: FeedEntry): Fragment {
  const values: string[] = [];
  if (entry.subjects?.length) values.push(entry.subjects.join(", "));
  const formatContent = [entry.format, entry.content].filter((v): v is string => Boolean(v));
  if (formatContent.length) values.push(formatContent.join(" · "));
  const issuedLang = [entry.issued, entry.language].filter((v): v is string => Boolean(v));
  if (issuedLang.length) values.push(issuedLang.join(" · "));
  if (entry.isPartOf) values.push(entry.isPartOf);

  if (values.length === 0) return "";
  const spans = interleave(
    values.map((v) => frag`<span>${v}</span>`),
    "\n                  ",
  );
  return frag`
                <div class="popup__meta">
                  ${spans}
                </div>`;
}

export function renderDownloads(entry: FeedEntry): Fragment {
  if (!entry.acquisitions?.length) return "";
  const buttons = interleave(
    entry.acquisitions.map((a) => frag`<a href="${safeHref(a.href)}" class="popup__download-btn">${formatFromMime(a.type)}</a>`),
    "\n                  ",
  );
  return frag`
                <div class="popup__downloads">
                  ${buttons}
                </div>`;
}
