import { breadcrumbsFor } from "../../src/render/breadcrumbs.ts";
import { renderShellState } from "../../src/render/shell-state.ts";
import { applyCoverStyles, dropBrokenCovers } from "./cover-placeholder.ts";
import { errorState, folderFeedsToPrefetch, loadFolder } from "./folder-load.ts";
import { parseFeedDom } from "./parse-feed-dom.ts";
import { initGlobal, wire } from "./viewer.ts";

function browserPath(pathname: string): string {
  if (pathname === "/index.html") return "/";

  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

async function boot(): Promise<void> {
  const app = document.getElementById("app");

  if (!app) return;

  dropBrokenCovers();
  const pathname = browserPath(location.pathname);
  const crumbs = breadcrumbsFor(pathname);

  for await (const state of loadFolder(pathname, {
    fetch: (url) => fetch(url),
    parse: parseFeedDom,
    sleep: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  })) {
    try {
      app.innerHTML = renderShellState(state, crumbs);

      if (state.kind !== "ready") continue;

      applyCoverStyles(app);
      document.title = state.model.title;
      // SAFETY: `connection` is the optional Network Information API extension to Navigator.
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;

      for (const url of folderFeedsToPrefetch(state.model, connection?.saveData === true)) {
        // SAFETY: browsers accept `priority`; DOM RequestInit omits it in some lib versions.
        void fetch(url, { priority: "low" } as RequestInit).catch(() => undefined);
      }
    } catch (error) {
      app.innerHTML = renderShellState(errorState(error instanceof Error ? error.message : undefined), crumbs);
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
