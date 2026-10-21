import { afterAll, describe, expect, test } from "bun:test";
import { Element as HappyElement, type HTMLAnchorElement as HappyAnchorElement, Window } from "happy-dom";

const MAIN_MODULE = "../../../ui/gridnav/main.ts";

const ROOT_FEED = await Bun.file(new URL("../../fixtures/feeds/root.xml", import.meta.url)).text();

const GLOBAL_PROPERTIES = [
  "document",
  "window",
  "location",
  "history",
  "DOMParser",
  "Element",
  "HTMLElement",
  "HTMLDialogElement",
] as const;

const ORIGINAL_GLOBALS = new Map(
  [...GLOBAL_PROPERTIES, "fetch", "setTimeout"].map(
    (property) => [property, Object.getOwnPropertyDescriptor(globalThis, property)] as const,
  ),
);

type ScenarioResult = {
  readonly stateClass: string | null;
  readonly stateText: string | null;
  readonly transientClass: string | null;
  readonly transientText: string | null;
  readonly homeHref: string | null;
  readonly hasGrid: boolean;
  readonly fetchCount: number;
  readonly retryDelayMs: number | null;
  readonly title: string | null;
};

function stateElement(app: HappyElement): HappyElement | null {
  return app.matches(".app-state") ? app : app.querySelector(".app-state");
}

function stateMessage(state: HappyElement | null): string | null {
  if (!state) return null;
  const copy = state.cloneNode(true);

  if (!(copy instanceof HappyElement)) return null;
  copy.querySelectorAll("a").forEach((link) => link.remove());

  return copy.textContent.trim();
}

async function runScenario(name: string, responses: readonly Response[]): Promise<ScenarioResult> {
  const browser = new Window({ url: "http://catalog.test/fiction/" });
  browser.document.body.innerHTML = '<div id="app"></div>';
  let fetchCount = 0;
  let retryDelayMs: number | null = null;

  for (const property of GLOBAL_PROPERTIES) {
    Object.defineProperty(globalThis, property, {
      configurable: true,
      writable: true,
      value: property === "window" ? browser : browser[property],
    });
  }

  const setTimeoutDescriptor = ORIGINAL_GLOBALS.get("setTimeout");

  if (setTimeoutDescriptor) Object.defineProperty(globalThis, "setTimeout", setTimeoutDescriptor);

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (): Promise<Response> => {
      const response = responses[Math.min(fetchCount, responses.length - 1)];
      fetchCount += 1;

      if (!response) throw new Error("No response configured");

      if (name === "starting" && fetchCount === 2) await Bun.sleep(20);

      return response.clone();
    },
  });

  if (name === "starting") {
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: (handler: () => void, delay = 0): number => {
        retryDelayMs = delay;
        handler();

        return 0;
      },
    });
  }

  await import(`${MAIN_MODULE}?scenario=${name}`);
  const app = browser.document.getElementById("app");

  if (!app) throw new Error("Missing app root");

  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (app.textContent !== "Loading…" && (name !== "starting" || fetchCount >= 2)) break;
    await Bun.sleep(1);
  }

  const transient = name === "starting" ? stateElement(app) : null;

  if (name === "starting") {
    for (let attempts = 0; attempts < 100 && app.querySelector(".books-grid") === null; attempts += 1) await Bun.sleep(1);
  }

  const state = stateElement(app);
  const hasGrid = app.querySelector(".books-grid") !== null;

  return {
    stateClass: state?.getAttribute("class") ?? null,
    stateText: stateMessage(state),
    transientClass: transient?.getAttribute("class") ?? null,
    transientText: stateMessage(transient),
    homeHref: app.querySelector<HappyAnchorElement>('a[href="/"]')?.getAttribute("href") ?? null,
    hasGrid,
    fetchCount,
    retryDelayMs,
    title: hasGrid ? browser.document.title : null,
  };
}

describe("browser shell boot", () => {
  test("maps feed responses to the rendered, starting, not-found and error states", async () => {
    // #given one successful feed and the three HTTP response classes the shell handles
    const feed = () => new Response(ROOT_FEED, { status: 200, headers: { "Content-Type": "application/atom+xml" } });
    const controls = new Window().document;
    const directState = controls.createElement("section");
    directState.className = "app-state app-state--not-found";
    directState.innerHTML = 'Folder not found<a href="/">Home</a>';
    const nestedRoot = controls.createElement("div");
    nestedRoot.innerHTML = '<section class="app-state app-state--error">Wrong folder<a href="/">Home</a></section>';
    const emptyRoot = controls.createElement("div");

    // #when each response is returned to a fresh browser shell
    const actual = {
      helperControls: {
        directClass: stateElement(directState)?.getAttribute("class") ?? null,
        nestedClass: stateElement(nestedRoot)?.getAttribute("class") ?? null,
        missingClass: stateElement(emptyRoot)?.getAttribute("class") ?? null,
        directMessage: stateMessage(directState),
        wrongMessage: stateMessage(stateElement(nestedRoot)),
        missingMessage: stateMessage(null),
      },
      rendered: await runScenario("rendered", [feed()]),
      starting: await runScenario("starting", [
        new Response('{"status":"initializing"}', { status: 503, headers: { "Retry-After": "60" } }),
        feed(),
      ]),
      notFound: await runScenario("not-found", [new Response("", { status: 404 })]),
      error: await runScenario("error", [new Response("", { status: 500 })]),
    };

    // #then the user sees the state for each status and a 503 is retried to the feed
    expect(actual).toEqual({
      helperControls: {
        directClass: "app-state app-state--not-found",
        nestedClass: "app-state app-state--error",
        missingClass: null,
        directMessage: "Folder not found",
        wrongMessage: "Wrong folder",
        missingMessage: null,
      },
      rendered: {
        stateClass: null,
        stateText: null,
        transientClass: null,
        transientText: null,
        homeHref: "/",
        hasGrid: true,
        fetchCount: 1,
        retryDelayMs: null,
        title: "fiction",
      },
      starting: {
        stateClass: null,
        stateText: null,
        transientClass: "app-state app-state--starting",
        transientText: "Server is starting, retrying in 30 s…",
        homeHref: "/",
        hasGrid: true,
        fetchCount: 2,
        retryDelayMs: 30_000,
        title: "fiction",
      },
      notFound: {
        stateClass: "app-state app-state--not-found",
        stateText: "Folder not found",
        transientClass: null,
        transientText: null,
        homeHref: "/",
        hasGrid: false,
        fetchCount: 1,
        retryDelayMs: null,
        title: null,
      },
      error: {
        stateClass: "app-state app-state--error",
        stateText: "Could not load this folder (status 500)",
        transientClass: null,
        transientText: null,
        homeHref: "/",
        hasGrid: false,
        fetchCount: 1,
        retryDelayMs: null,
        title: null,
      },
    });
  });
});

afterAll(() => {
  for (const [property, descriptor] of ORIGINAL_GLOBALS) {
    if (descriptor) Object.defineProperty(globalThis, property, descriptor);
    else Reflect.deleteProperty(globalThis, property);
  }
});
