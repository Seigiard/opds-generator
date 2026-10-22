import type { HtmlEscapedString } from "hono/utils/html";
import type { Crumb } from "./breadcrumbs.ts";
import type { FeedModel } from "./feed-model.ts";
import { frag } from "./frag.ts";
import { safeHref } from "./safe-href.ts";

export function renderHeader(model: Pick<FeedModel, "title">, crumbs: Crumb[], skeleton = false): HtmlEscapedString {
  const home =
    crumbs.length === 0
      ? ""
      : frag`
        <a class="header__home" href="/" aria-label="Home">
          <svg xmlns="http://www.w3.org/2000/svg" class="header__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
          </svg>
        </a>
        <span class="header__separator">/</span>`;

  const crumbLinks = crumbs.slice(0, -1).flatMap((crumb, index) => {
    const link = frag`<a href="${safeHref(crumb.href)}">${crumb.label}</a>`;

    return index === 0 ? [link] : [frag`<span class="header__separator">/</span>`, link];
  });

  const titleSeparator = crumbs.length > 1 ? frag`<span class="header__separator">/</span>` : "";
  const titleClass = skeleton ? "header__title skeleton__title" : "header__title";
  const ariaHidden = skeleton ? frag` aria-hidden="true"` : "";

  return frag`<header class="header"${ariaHidden}>
      <div class="header__left">
        <nav class="header__breadcrumb">${home}${crumbLinks}${titleSeparator}
        </nav>
        <h1 class="${titleClass}">${model.title}</h1>
      </div>
    </header>`;
}
