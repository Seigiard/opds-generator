import { breadcrumbsFor } from "../../src/render/breadcrumbs.ts";
import { renderHtml } from "../../src/render/feed-html.ts";
import { parseFeedDom } from "./parse-feed-dom.ts";
import { initGlobal, wire } from "./viewer.ts";

function browserPath(pathname: string): string {
  if (pathname === "/index.html") return "/";

  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

async function boot(): Promise<void> {
  const app = document.getElementById("app");

  if (!app) return;

  const pathname = browserPath(location.pathname);
  app.textContent = "Loading…";

  try {
    const response = await fetch(`/_catalog${pathname}feed.xml`);

    if (!response.ok) throw new Error(`Feed request failed (${response.status})`);

    const model = parseFeedDom(await response.text());
    const crumbs = breadcrumbsFor(pathname);
    app.innerHTML = renderHtml(model, crumbs);
    document.title = crumbs.at(-1)?.label ?? model.title;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feed request failed";
    app.textContent = message;
  }

  initGlobal();
  wire(app);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
} else {
  void boot();
}
