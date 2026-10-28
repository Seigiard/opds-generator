import { breadcrumbsFor } from "../../src/render/breadcrumbs.ts";
import { renderHtml } from "../../src/render/feed-html.ts";
import type { FeedModel } from "../../src/render/feed-model.ts";
import { renderHeader } from "../../src/render/header.ts";
import { applyCoverStyles, dropBrokenCovers } from "./cover-placeholder.ts";
import { parseFeedDom } from "./parse-feed-dom.ts";
import { initGlobal, wire } from "./viewer.ts";

const LOADING_DELAY_MS = 300;

const PREFETCH_LIMIT = 20;

const SKELETON_CARD_COUNT = 6;

function browserPath(pathname: string): string {
  if (pathname === "/index.html") return "/";

  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function showState(app: HTMLElement, className: string, message: string, withHome = false): void {
  const state = document.createElement("section");
  state.className = `app-state ${className}`;
  state.append(document.createTextNode(message));

  if (withHome) {
    const home = document.createElement("a");
    home.href = "/";
    home.textContent = "Home";
    state.append(home);
  }

  app.replaceChildren(state);
}

function retryAfterSeconds(response: Response): number {
  const value = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);

  if (!Number.isFinite(value) || value < 0) return 5;

  return Math.min(value, 30);
}

function showSkeleton(app: HTMLElement, crumbs: Parameters<typeof renderHeader>[1]): void {
  const cards = Array.from(
    { length: SKELETON_CARD_COUNT },
    () => `
      <div>
        <article class="card card--skeleton" aria-hidden="true">
          <div class="book"><div class="book__cover"></div></div>
          <div class="card__info"><span class="skeleton__label"></span></div>
        </article>
      </div>`,
  ).join("\n");

  app.innerHTML = `
    ${String(renderHeader({ title: "" }, crumbs, true))}
    <main class="books-grid">${cards}
    </main>`;
}

function prefetchFolders(model: FeedModel): void {
  // SAFETY: `connection` is the optional Network Information API extension to Navigator.
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;

  if (connection?.saveData === true) return;

  const folderUrls = model.entries.reduce<string[]>((urls, entry) => {
    if (
      urls.length >= PREFETCH_LIMIT ||
      entry.kind !== "folder" ||
      !entry.href ||
      !entry.href.startsWith("/_catalog/") ||
      !entry.href.endsWith("/feed.xml")
    ) {
      return urls;
    }

    urls.push(entry.href);

    return urls;
  }, []);

  for (const url of folderUrls) {
    // SAFETY: browsers accept `priority` as a fetch extension; DOM RequestInit omits it in some lib versions.
    void fetch(url, { priority: "low" } as RequestInit).catch(() => undefined);
  }
}

async function boot(): Promise<void> {
  const app = document.getElementById("app");

  if (!app) return;

  dropBrokenCovers();
  const pathname = browserPath(location.pathname);
  const crumbs = breadcrumbsFor(pathname);
  const loadingTimer = setTimeout(() => showSkeleton(app, crumbs), LOADING_DELAY_MS);
  let loadingFinished = false;

  const finishLoading = (): void => {
    if (loadingFinished) return;

    loadingFinished = true;
    clearTimeout(loadingTimer);
  };

  while (true) {
    try {
      const response = await fetch(`/_catalog${pathname}feed.xml`);

      if (response.status === 503) {
        const seconds = retryAfterSeconds(response);
        showState(app, "app-state--starting", `Server is starting, retrying in ${seconds} s…`);
        finishLoading();
        await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
        continue;
      }

      if (response.status === 404) {
        showState(app, "app-state--not-found", "Folder not found", true);
        finishLoading();
        break;
      }

      if (!response.ok) {
        showState(app, "app-state--error", `Could not load this folder (status ${response.status})`, true);
        finishLoading();
        break;
      }

      const model = parseFeedDom(await response.text());
      app.innerHTML = renderHtml(model, crumbs);
      applyCoverStyles(app);
      finishLoading();
      document.title = model.title;
      prefetchFolders(model);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load this folder";
      showState(app, "app-state--error", message, true);
      finishLoading();
      break;
    }
  }

  initGlobal();
  wire(app);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
} else {
  void boot();
}
