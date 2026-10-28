import { afterAll, describe, expect, test } from "bun:test";
import { Element as HappyElement, type HTMLAnchorElement as HappyAnchorElement, Window } from "happy-dom";

const MAIN_MODULE = "../../../ui/gridnav/main.ts";

const ROOT_FEED = await Bun.file(new URL("../../fixtures/feeds/root.xml", import.meta.url)).text();

const PREFETCH_FEED = await Bun.file(new URL("../../fixtures/feeds/prefetch-folders.xml", import.meta.url)).text();

const GLOBAL_PROPERTIES = [
  "document",
  "window",
  "location",
  "history",
  "DOMParser",
  "Element",
  "HTMLElement",
  "HTMLDialogElement",
  "navigator",
] as const;

const ORIGINAL_GLOBALS = new Map(
  [...GLOBAL_PROPERTIES, "fetch", "setTimeout", "clearTimeout"].map(
    (property) => [property, Object.getOwnPropertyDescriptor(globalThis, property)] as const,
  ),
);

type FetchCall = {
  readonly priority: string | undefined;
  readonly url: string;
};

type BootOptions = {
  readonly noConnection?: boolean;
  readonly observeTimer?: (delay: number, app: HappyElement) => void;
  readonly saveData?: boolean;
  readonly url?: string;
};

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }

  throw new Error("Timed out waiting for browser shell state");
}

async function boot(
  responses: readonly Response[],
  options: BootOptions = {},
): Promise<{ app: HappyElement; calls: FetchCall[]; title: string }> {
  const browser = new Window({ url: options.url ?? "http://catalog.test/fiction/" });
  browser.document.body.innerHTML = '<div id="app"></div>';

  if (!options.noConnection) {
    Object.defineProperty(browser.navigator, "connection", { configurable: true, value: { saveData: options.saveData } });
  }

  for (const property of GLOBAL_PROPERTIES) {
    Object.defineProperty(globalThis, property, {
      configurable: true,
      writable: true,
      value: property === "window" ? browser : browser[property],
    });
  }

  const calls: FetchCall[] = [];
  let responseIndex = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: string | URL | Request, init?: { priority?: string }): Promise<Response> => {
      calls.push({ priority: init?.priority, url: input instanceof Request ? input.url : input.toString() });
      const response = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex += 1;

      if (!response) throw new Error("No response configured");

      return response.clone();
    },
  });

  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (handler: () => void, delay = 0): number => {
      const app = browser.document.getElementById("app");

      if (app instanceof HappyElement) options.observeTimer?.(delay, app);
      queueMicrotask(handler);

      return 0;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: () => undefined });

  await import(`${MAIN_MODULE}?wiring=${crypto.randomUUID()}`);
  const app = browser.document.getElementById("app");

  if (!(app instanceof HappyElement)) throw new Error("Missing app root");

  return { app, calls, title: browser.document.title };
}

describe("browser shell boot wiring", () => {
  test("renders a ready folder, sets the title, and prefetches its first 20 folders at low priority", async () => {
    // #given a ready folder feed that has more than 20 child folders
    const shell = await boot([new Response(PREFETCH_FEED, { status: 200 })]);
    await waitFor(() => shell.app.querySelector(".books-grid") !== null && shell.calls.length === 21);

    // #when the adapter consumes the ready state
    const prefetches = shell.calls.slice(1);

    // #then it renders the folder and issues the specified low-priority requests
    expect({
      prefetches,
      rendered: shell.app.querySelector(".books-grid") !== null,
      title: shell.title,
    }).toEqual({
      prefetches: Array.from({ length: 20 }, (_, index) => ({
        priority: "low",
        url: `/_catalog/prefetch/folder-${String(index + 1).padStart(2, "0")}/feed.xml`,
      })),
      rendered: true,
      title: "Prefetch folders",
    });
  });

  test("normalizes a folder URL without a trailing slash and prefetches without connection information", async () => {
    // #given a browser without the optional Network Information API at a folder URL without a trailing slash
    const shell = await boot([new Response(PREFETCH_FEED, { status: 200 })], {
      noConnection: true,
      url: "http://catalog.test/fiction",
    });

    await waitFor(() => shell.app.querySelector(".books-grid") !== null && shell.calls.length === 21);

    // #when the adapter consumes the ready state
    const result = {
      firstRequest: shell.calls[0],
      prefetches: shell.calls.slice(1),
      rendered: shell.app.querySelector(".books-grid") !== null,
    };

    // #then it requests the normalized folder feed and preserves ready rendering with all low-priority prefetches
    expect(result).toEqual({
      firstRequest: { priority: undefined, url: "/_catalog/fiction/feed.xml" },
      prefetches: Array.from({ length: 20 }, (_, index) => ({
        priority: "low",
        url: `/_catalog/prefetch/folder-${String(index + 1).padStart(2, "0")}/feed.xml`,
      })),
      rendered: true,
    });
  });

  test("normalizes index.html to the catalog root feed", async () => {
    // #given a browser address that names the shell document
    const shell = await boot([new Response(ROOT_FEED, { status: 200 })], { url: "http://catalog.test/index.html" });
    await waitFor(() => shell.calls.length > 0);

    // #when the adapter starts folder loading
    const firstRequest = shell.calls[0];

    // #then it loads the catalog root rather than a nested index.html folder
    expect(firstRequest).toEqual({ priority: undefined, url: "/_catalog/feed.xml" });
  });

  test("suppresses prefetch requests when the connection saves data", async () => {
    // #given a ready folder feed and an explicit data-saving connection
    const shell = await boot([new Response(PREFETCH_FEED, { status: 200 })], { saveData: true });
    await waitFor(() => shell.app.querySelector(".books-grid") !== null);

    // #when the adapter consumes the ready state
    const requests = shell.calls;

    // #then it fetches only the visible folder feed
    expect(requests).toEqual([{ priority: undefined, url: "/_catalog/fiction/feed.xml" }]);
  });

  test("renders the starting state for a 503 before retrying to a ready folder", async () => {
    // #given a server-starting response followed by a ready feed
    const observed: Array<{ delay: number; text: string }> = [];

    const shell = await boot(
      [new Response("", { status: 503, headers: { "Retry-After": "30" } }), new Response(ROOT_FEED, { status: 200 })],
      {
        observeTimer: (delay, app) => {
          if (delay === 30_000) observed.push({ delay, text: app.textContent?.trim() ?? "" });
        },
      },
    );

    await waitFor(() => shell.app.querySelector(".books-grid") !== null);

    // #when the retry completes
    const rendered = shell.app.querySelector(".books-grid") !== null;

    // #then the user saw the retry status before the folder became ready
    expect({ observed, rendered }).toEqual({
      observed: [{ delay: 30_000, text: "Server is starting, retrying in 30 s…" }],
      rendered: true,
    });
  });

  test("renders a terminal error state with its Home link", async () => {
    // #given a terminal server error response
    const shell = await boot([new Response("", { status: 500 })]);
    await waitFor(() => shell.app.querySelector(".app-state") !== null);

    // #when the adapter consumes the terminal error state
    const state = shell.app.querySelector(".app-state");
    const home = shell.app.querySelector<HappyAnchorElement>('a[href="/"]');

    // #then the shell keeps the status copy and root navigation
    expect({ className: state?.getAttribute("class"), home: home?.getAttribute("href"), text: state?.textContent }).toEqual({
      className: "app-state app-state--error",
      home: "/",
      text: "Could not load this folder (status 500)Home",
    });
  });
});

afterAll(() => {
  for (const [property, descriptor] of ORIGINAL_GLOBALS) {
    if (descriptor) Object.defineProperty(globalThis, property, descriptor);
    else Reflect.deleteProperty(globalThis, property);
  }
});
