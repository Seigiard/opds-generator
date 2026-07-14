import type { FeedEntry, FeedModel } from "./feed-model.ts";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
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

const FAVICON_LINKS = [
  '<link rel="icon" type="image/png" href="/static/favicon/favicon-96x96.png" sizes="96x96" />',
  '<link rel="icon" type="image/svg+xml" href="/static/favicon/favicon.svg" />',
  '<link rel="shortcut icon" href="/static/favicon/favicon.ico" />',
  '<link rel="apple-touch-icon" sizes="180x180" href="/static/favicon/apple-touch-icon.png" />',
  '<link rel="manifest" href="/static/favicon/site.webmanifest" />',
].join("\n    ");

export function renderHtml(model: FeedModel): string {
  const title = escapeHtml(model.title);
  let bookIndex = 0;
  const cards = model.entries.map((entry) => (entry.kind === "folder" ? renderFolder(entry) : renderBook(entry, ++bookIndex))).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
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
`;
}

function renderHeader(model: FeedModel): string {
  const title = escapeHtml(model.title);
  const isRoot = model.selfHref === model.startHref;
  const home = isRoot
    ? ""
    : `
        <a class="header__home" href="${escapeAttr(model.startHref)}" aria-label="Home">
          <svg xmlns="http://www.w3.org/2000/svg" class="header__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
          </svg>
        </a>`;

  return `<header class="header">
      <div class="header__left">
        <nav class="header__breadcrumb">${home}
        </nav>
        <h1 class="header__title">${title}</h1>
      </div>
    </header>`;
}

function renderCover(entry: FeedEntry, src: string | undefined, lazy: boolean): string {
  if (src) {
    const loading = lazy ? ' loading="lazy"' : "";
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(entry.title)}"${loading} />`;
  }
  return `<span>${escapeHtml(entry.title)}</span>`;
}

function renderFolder(entry: FeedEntry): string {
  const title = escapeHtml(entry.title);
  const href = escapeAttr(entry.href ?? "#");
  const stack = Array(3)
    .fill(`<div class="book" aria-hidden="true"><div class="book__cover"><span>${title}</span></div></div>`)
    .join("\n        ");
  const description = entry.summary ? `\n          <p class="card__description">${escapeHtml(entry.summary)}</p>` : "";

  return `      <div>
        <article class="card card--folder">
        ${stack}
        <div class="card__info">
          <h3 class="card__title"><a href="${href}">${title}</a></h3>${description}
        </div>
        </article>
      </div>`;
}

function renderBook(entry: FeedEntry, index: number): string {
  const title = escapeHtml(entry.title);
  const popupId = `book-${index}`;
  const author = entry.author ? `\n          <p class="card__description">${escapeHtml(entry.author)}</p>` : "";
  const cardCover = renderCover(entry, entry.thumbnail, true);
  const popupCover = renderCover(entry, entry.cover ?? entry.thumbnail, false);

  return `      <div>
        <article class="card card--book">
          <div class="book" aria-hidden="true">
            <div class="book__cover">${cardCover}</div>
          </div>
          <div class="card__info">
            <h3 class="card__title"><a href="#${popupId}">${title}</a></h3>${author}
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
                <h2 class="popup__title">${title}</h2>${
                  entry.author ? `\n                <p class="popup__author">${escapeHtml(entry.author)}</p>` : ""
                }
              </hgroup>${entry.summary ? `\n              <p class="popup__description">${escapeHtml(entry.summary)}</p>` : ""}
              <div class="popup__footer">${renderMeta(entry)}${renderDownloads(entry)}
              </div>
            </div>
          </div>
        </div>
      </div>`;
}

function renderMeta(entry: FeedEntry): string {
  const spans: string[] = [];
  if (entry.subjects?.length) spans.push(escapeHtml(entry.subjects.join(", ")));
  const formatContent = [entry.format, entry.content].filter(Boolean).map((v) => escapeHtml(v as string));
  if (formatContent.length) spans.push(formatContent.join(" · "));
  const issuedLang = [entry.issued, entry.language].filter(Boolean).map((v) => escapeHtml(v as string));
  if (issuedLang.length) spans.push(issuedLang.join(" · "));
  if (entry.isPartOf) spans.push(escapeHtml(entry.isPartOf));

  if (spans.length === 0) return "";
  const body = spans.map((s) => `<span>${s}</span>`).join("\n                  ");
  return `
                <div class="popup__meta">
                  ${body}
                </div>`;
}

function renderDownloads(entry: FeedEntry): string {
  if (!entry.acquisitions?.length) return "";
  const buttons = entry.acquisitions
    .map((a) => `<a href="${escapeAttr(a.href)}" class="popup__download-btn">${escapeHtml(formatFromMime(a.type))}</a>`)
    .join("\n                  ");
  return `
                <div class="popup__downloads">
                  ${buttons}
                </div>`;
}
