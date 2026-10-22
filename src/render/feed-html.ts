import type { HtmlEscapedString } from "hono/utils/html";
import { VIEWABLE_FORMATS } from "../types.ts";
import type { Crumb } from "./breadcrumbs.ts";
import type { FeedEntry, FeedModel } from "./feed-model.ts";
import { frag } from "./frag.ts";
import { renderHeader } from "./header.ts";
import { safeHref } from "./safe-href.ts";

type Fragment = HtmlEscapedString | string;

/** Interleave fragments with a literal separator instead of `.join()`, which would strip the escaped marker (KTD-3). */
function interleave(items: Fragment[], separator: string): Fragment[] {
  return items.flatMap((item, i) => (i === 0 ? [item] : [separator, item]));
}

/** Reader links point at feed.xml; browsers need the folder URL nginx resolves to index.html. */
export function browserHref(feedHref: string): string {
  const folderUrl = feedHref.replace(/feed\.xml$/, "").replace(/^\/_catalog\//, "/");

  return folderUrl === "" ? "/" : folderUrl;
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

export function renderHtml(model: FeedModel, crumbs: Crumb[]): string {
  let bookIndex = 0;

  const cards = interleave(
    model.entries.map((entry) => (entry.kind === "folder" ? renderFolder(entry) : renderBook(entry, ++bookIndex))),
    "\n",
  );

  return String(renderFragment(model, crumbs, cards));
}

function renderFragment(model: FeedModel, crumbs: Crumb[], cards: Fragment[]): HtmlEscapedString {
  return frag`${renderHeader(model, crumbs)}
    <main class="books-grid" data-element=".card__title a">
${cards}
    </main>`;
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
        <dialog class="popup" id="${popupId}" aria-labelledby="${popupId}-title">
          <div class="popup__content">
            <div class="popup__cover" aria-hidden="true">
              <div class="book"><div class="book__cover">${popupCover}</div></div>
            </div>
            <div class="popup__info">
              <a class="popup__close-button" href="#"><span>Close</span></a>
              <hgroup>
                <h2 class="popup__title" id="${popupId}-title">${entry.title}</h2>${popupAuthor}
              </hgroup>${popupDescription}
              <div class="popup__footer">${renderMeta(entry)}${renderDownloads(entry)}
              </div>
            </div>
          </div>
        </dialog>
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
    entry.acquisitions.map((a) => {
      const href = safeHref(a.href);
      const label = formatFromMime(a.type);
      const download = frag`<a href="${href}" class="popup__download-btn">${label}</a>`;

      // View only for registry formats on root-relative book paths: the reader fragment
      // must never carry a scheme or external host (R15 first line of defense).
      if (!VIEWABLE_FORMATS.has(label.toLowerCase()) || !href.startsWith("/")) return download;

      return frag`${download} <a href="${`/_app/read.html#${href}`}" class="popup__view-btn">View</a>`;
    }),
    "\n                  ",
  );

  return frag`
                <div class="popup__downloads">
                  ${buttons}
                </div>`;
}
