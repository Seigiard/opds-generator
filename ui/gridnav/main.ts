import { breadcrumbsFor } from "../../src/render/breadcrumbs.ts";
import { renderHtml } from "../../src/render/feed-html.ts";
import { parseFeedDom } from "./parse-feed-dom.ts";
import { initGlobal, wire } from "./viewer.ts";

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

async function boot(): Promise<void> {
  const app = document.getElementById("app");

  if (!app) return;

  const pathname = browserPath(location.pathname);
  app.textContent = "Loading…";

  while (true) {
    try {
      const response = await fetch(`/_catalog${pathname}feed.xml`);

      if (response.status === 503) {
        const seconds = retryAfterSeconds(response);
        showState(app, "app-state--starting", `Server is starting, retrying in ${seconds} s…`);
        await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
        continue;
      }

      if (response.status === 404) {
        showState(app, "app-state--not-found", "Folder not found", true);
        break;
      }

      if (!response.ok) {
        showState(app, "app-state--error", `Could not load this folder (status ${response.status})`, true);
        break;
      }

      const model = parseFeedDom(await response.text());
      const crumbs = breadcrumbsFor(pathname);
      app.innerHTML = renderHtml(model, crumbs);
      document.title = crumbs.at(-1)?.label ?? model.title;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load this folder";
      showState(app, "app-state--error", message, true);
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
