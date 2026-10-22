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
  "clearTimeout",
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
  readonly fetchedUrls: readonly string[];
  readonly retryDelayMs: number | null;
  readonly title: string | null;
};

type FetchCall = {
  readonly priority: string | undefined;
  readonly url: string;
};

type TimedBoot = {
  readonly app: HappyElement;
  readonly calls: FetchCall[];
  readonly fireTimers: (throughMs: number) => void;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: T) => void;
};

type DeferredResponseBody = {
  readonly deliver: (body: string) => void;
  readonly response: Response;
};

type PendingSnapshot = {
  readonly appState: string | null;
  readonly childCount: number;
  readonly hasPlaceholderCard: boolean;
  readonly text: string;
};

type SkeletonSnapshot = {
  readonly breadcrumbHrefs: readonly string[];
  readonly hasPlaceholderCard: boolean;
  readonly headerClass: string | null;
  readonly loadingText: boolean;
  readonly titleText: string | null;
};

type StatusSnapshot = {
  readonly hasPlaceholderCard: boolean;
  readonly stateClass: string | null;
  readonly stateText: string | null;
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

function deferred<T>(): Deferred<T> {
  let reject!: (error: Error) => void;
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = (error) => fail(error);
  });

  return { promise, reject, resolve };
}

function responseWithDeferredBody(): DeferredResponseBody {
  let controller!: ReadableStreamDefaultController<Uint8Array>;

  const body = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });

  return {
    deliver: (contents) => {
      controller.enqueue(new TextEncoder().encode(contents));
      controller.close();
    },
    response: new Response(body, { status: 200, headers: { "Content-Type": "application/atom+xml" } }),
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }

  throw new Error("Timed out waiting for browser shell state");
}

async function bootWithDelayedFeed(
  feed: Promise<Response>,
  connection: { readonly saveData?: boolean } | undefined,
  browserUrl = "http://catalog.test/fiction/",
): Promise<TimedBoot> {
  const browser = new Window({ url: browserUrl });
  browser.document.body.innerHTML = '<div id="app"></div>';
  Object.defineProperty(browser.navigator, "connection", {
    configurable: true,
    value: connection,
  });
  const calls: FetchCall[] = [];
  const timers = new Map<number, { cancelled: boolean; delay: number; handler: () => void }>();
  let nextTimerId = 0;

  for (const property of GLOBAL_PROPERTIES) {
    Object.defineProperty(globalThis, property, {
      configurable: true,
      writable: true,
      value: property === "window" ? browser : browser[property],
    });
  }

  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (handler: () => void, delay = 0): number => {
      nextTimerId += 1;
      timers.set(nextTimerId, { cancelled: false, delay, handler });

      return nextTimerId;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: (timerId: number): void => {
      const timer = timers.get(timerId);

      if (timer) timer.cancelled = true;
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: string | URL | Request, init?: { priority?: string }): Promise<Response> => {
      calls.push({
        priority: init?.priority,
        url: input instanceof Request ? input.url : input.toString(),
      });

      return calls.length === 1 ? await feed : new Response("", { status: 200 });
    },
  });

  await import(`${MAIN_MODULE}?timed-scenario=${crypto.randomUUID()}`);
  const app = browser.document.getElementById("app");

  if (!(app instanceof HappyElement)) throw new Error("Missing app root");

  await waitFor(() => calls.length === 1);

  return {
    app,
    calls,
    fireTimers: (throughMs) => {
      for (const [timerId, timer] of timers) {
        if (timer.cancelled || timer.delay > throughMs) continue;
        timers.delete(timerId);
        timer.handler();
      }
    },
  };
}

function pendingSnapshot(app: HappyElement): PendingSnapshot {
  return {
    appState: stateElement(app)?.getAttribute("class") ?? null,
    childCount: app.children.length,
    hasPlaceholderCard: app.querySelector(".card--skeleton") !== null,
    text: app.textContent?.trim() ?? "",
  };
}

function skeletonSnapshot(app: HappyElement): SkeletonSnapshot {
  const cards = Array.from(app.querySelectorAll(".books-grid .card"));

  return {
    breadcrumbHrefs: Array.from(app.querySelectorAll<HappyAnchorElement>(".header__breadcrumb a")).map(
      (link) => link.getAttribute("href") ?? "",
    ),
    hasPlaceholderCard: cards.some((card) => card.querySelector("a") === null),
    headerClass: app.querySelector("header")?.getAttribute("class") ?? null,
    loadingText: (app.textContent ?? "").includes("Loading…"),
    titleText: app.querySelector(".header__title")?.textContent?.trim() ?? null,
  };
}

function statusSnapshot(app: HappyElement): StatusSnapshot {
  const state = stateElement(app);

  return {
    hasPlaceholderCard: app.querySelector(".card--skeleton") !== null,
    stateClass: state?.getAttribute("class") ?? null,
    stateText: stateMessage(state),
  };
}

async function runScenario(
  name: string,
  responses: readonly Response[],
  browserUrl = "http://catalog.test/fiction/",
): Promise<ScenarioResult> {
  const browser = new Window({ url: browserUrl });
  browser.document.body.innerHTML = '<div id="app"></div>';
  const currentFolderFeedUrl = "/_catalog/fiction/feed.xml";
  let responseFetchCount = 0;
  const fetchedUrls: string[] = [];
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
    value: async (input: string | URL | Request): Promise<Response> => {
      const response = responses[Math.min(responseFetchCount, responses.length - 1)];
      responseFetchCount += 1;
      fetchedUrls.push(input instanceof Request ? input.url : input.toString());

      if (!response) throw new Error("No response configured");

      if (name === "starting" && responseFetchCount === 2) await Bun.sleep(20);

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
    if (
      (name === "starting" && responseFetchCount >= 2) ||
      (name !== "starting" && (stateElement(app) || app.querySelector(".books-grid")))
    ) {
      break;
    }

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
    fetchCount: fetchedUrls.filter((url) => url === currentFolderFeedUrl).length,
    fetchedUrls: fetchedUrls.filter((url) => url === currentFolderFeedUrl),
    retryDelayMs,
    title: hasGrid ? browser.document.title : null,
  };
}

describe("browser shell boot", () => {
  test("keeps the app empty when the feed resolves before the loading delay", async () => {
    // #given a feed response held until the shell has started its loading delay
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, { saveData: false });

    // #when 299 ms elapse and the feed resolves before the 300 ms timer fires
    shell.fireTimers(299);
    const beforeFeed = pendingSnapshot(shell.app);
    response.resolve(new Response(ROOT_FEED, { status: 200, headers: { "Content-Type": "application/atom+xml" } }));
    await waitFor(() => shell.app.querySelector(".books-grid") !== null);
    shell.fireTimers(300);
    const afterTimer = skeletonSnapshot(shell.app);

    // #then no loading state was visible and the late timer leaves the rendered catalogue in place
    expect({
      afterTimer: {
        breadcrumbHrefs: afterTimer.breadcrumbHrefs,
        hasPlaceholderCard: afterTimer.hasPlaceholderCard,
        titleText: afterTimer.titleText,
      },
      beforeFeed,
      hasGrid: shell.app.querySelector(".books-grid") !== null,
      hasLoadingText: (shell.app.textContent ?? "").includes("Loading…"),
      stateClass: stateElement(shell.app)?.getAttribute("class") ?? null,
    }).toEqual({
      afterTimer: { breadcrumbHrefs: ["/"], hasPlaceholderCard: false, titleText: "Catalog" },
      beforeFeed: { appState: null, childCount: 0, hasPlaceholderCard: false, text: "" },
      hasGrid: true,
      hasLoadingText: false,
      stateClass: null,
    });
  });

  test("shows a header and card skeleton after 300 ms until the feed resolves", async () => {
    // #given a feed response that remains pending beyond the loading delay
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, { saveData: false });

    // #when 299 ms and then 300 ms elapse before the response resolves
    shell.fireTimers(299);
    const beforeDelay = pendingSnapshot(shell.app);
    shell.fireTimers(300);
    const afterDelay = skeletonSnapshot(shell.app);
    response.resolve(new Response(ROOT_FEED, { status: 200, headers: { "Content-Type": "application/atom+xml" } }));
    await waitFor(() => shell.app.querySelector(".books-grid") !== null && skeletonSnapshot(shell.app).hasPlaceholderCard === false);

    // #then the skeleton replaces the empty shell, then the rendered folder replaces the skeleton
    expect({ afterDelay, afterFeed: skeletonSnapshot(shell.app), beforeDelay }).toEqual({
      afterDelay: {
        breadcrumbHrefs: ["/"],
        hasPlaceholderCard: true,
        headerClass: "header",
        loadingText: false,
        titleText: "",
      },
      afterFeed: {
        breadcrumbHrefs: ["/"],
        hasPlaceholderCard: false,
        headerClass: "header",
        loadingText: false,
        titleText: "Catalog",
      },
      beforeDelay: { appState: null, childCount: 0, hasPlaceholderCard: false, text: "" },
    });
  });

  test("shows a skeleton while a feed body streams after its headers", async () => {
    // #given response headers that arrive before the feed body
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, { saveData: false });
    const streamedResponse = responseWithDeferredBody();
    response.resolve(streamedResponse.response);
    await Bun.sleep(1);

    // #when the loading delay elapses before the body is delivered
    shell.fireTimers(300);
    const afterDelay = skeletonSnapshot(shell.app);
    streamedResponse.deliver(ROOT_FEED);
    await waitFor(() => shell.app.querySelector(".books-grid") !== null && skeletonSnapshot(shell.app).hasPlaceholderCard === false);

    // #then the skeleton remains visible while the body streams and the catalogue replaces it after delivery
    expect({ afterDelay, afterBody: skeletonSnapshot(shell.app) }).toEqual({
      afterDelay: {
        breadcrumbHrefs: ["/"],
        hasPlaceholderCard: true,
        headerClass: "header",
        loadingText: false,
        titleText: "",
      },
      afterBody: {
        breadcrumbHrefs: ["/"],
        hasPlaceholderCard: false,
        headerClass: "header",
        loadingText: false,
        titleText: "Catalog",
      },
    });
  });

  test("keeps the not-found state after the loading delay", async () => {
    // #given a folder feed that returns 404 before the loading delay
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, { saveData: false });
    response.resolve(new Response("", { status: 404 }));
    await waitFor(() => statusSnapshot(shell.app).stateClass !== null);

    // #when the delayed loading timer fires after the not-found state rendered
    shell.fireTimers(300);

    // #then the literal not-found state remains instead of a skeleton
    expect(statusSnapshot(shell.app)).toEqual({
      hasPlaceholderCard: false,
      stateClass: "app-state app-state--not-found",
      stateText: "Folder not found",
    });
  });

  test("keeps the HTTP error state after the loading delay", async () => {
    // #given a folder feed that returns an HTTP error before the loading delay
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, { saveData: false });
    response.resolve(new Response("", { status: 500 }));
    await waitFor(() => statusSnapshot(shell.app).stateClass !== null);

    // #when the delayed loading timer fires after the error state rendered
    shell.fireTimers(300);

    // #then the literal HTTP error state remains instead of a skeleton
    expect(statusSnapshot(shell.app)).toEqual({
      hasPlaceholderCard: false,
      stateClass: "app-state app-state--error",
      stateText: "Could not load this folder (status 500)",
    });
  });

  test("keeps the thrown-fetch error state after the loading delay", async () => {
    // #given a fetch that throws before the loading delay
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, { saveData: false });
    response.reject(new Error("Network offline"));
    await waitFor(() => statusSnapshot(shell.app).stateClass !== null);

    // #when the delayed loading timer fires after the error state rendered
    shell.fireTimers(300);

    // #then the thrown-fetch error state remains instead of a skeleton
    expect(statusSnapshot(shell.app)).toEqual({
      hasPlaceholderCard: false,
      stateClass: "app-state app-state--error",
      stateText: "Network offline",
    });
  });

  test("keeps the starting state after the loading delay", async () => {
    // #given a server-starting response before the loading delay
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, { saveData: false });
    response.resolve(new Response('{"status":"initializing"}', { status: 503, headers: { "Retry-After": "30" } }));
    await waitFor(() => statusSnapshot(shell.app).stateClass !== null);

    // #when the delayed loading timer fires while the retry timer waits
    shell.fireTimers(300);

    // #then the literal starting state remains instead of a skeleton
    expect(statusSnapshot(shell.app)).toEqual({
      hasPlaceholderCard: false,
      stateClass: "app-state app-state--starting",
      stateText: "Server is starting, retrying in 30 s…",
    });
  });

  test("shows current-path breadcrumbs in the delayed skeleton", async () => {
    // #given slow feeds for a one-level and a nested folder URL
    const fictionResponse = deferred<Response>();
    const fiction = await bootWithDelayedFeed(fictionResponse.promise, { saveData: false });
    const nestedResponse = deferred<Response>();
    const nested = await bootWithDelayedFeed(nestedResponse.promise, { saveData: false }, "http://catalog.test/a/b/");

    // #when the loading delay elapses before either feed resolves
    fiction.fireTimers(300);
    nested.fireTimers(300);

    // #then each skeleton has the breadcrumb links derived from its URL
    expect({ fiction: skeletonSnapshot(fiction.app).breadcrumbHrefs, nested: skeletonSnapshot(nested.app).breadcrumbHrefs }).toEqual({
      fiction: ["/"],
      nested: ["/", "/a/"],
    });
  });

  test("prefetches the first 20 folder feeds with low priority after rendering", async () => {
    // #given a rendered folder containing 21 subfolders and one book with image and acquisition URLs
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, { saveData: false });
    response.resolve(
      new Response(PREFETCH_FEED, {
        status: 200,
        headers: { "Content-Type": "application/atom+xml" },
      }),
    );
    await waitFor(() => shell.app.querySelector(".books-grid") !== null);
    await Bun.sleep(1);

    // #when the shell completes the folder render
    const prefetches = shell.calls.slice(1);

    // #then it requests exactly the first 20 folder feed URLs from the fixture, not book assets
    expect(prefetches).toEqual(
      Array.from({ length: 20 }, (_, index) => ({
        priority: "low",
        url: `/_catalog/prefetch/folder-${String(index + 1).padStart(2, "0")}/feed.xml`,
      })),
    );
  });

  test("does not prefetch folder feeds when the connection saves data", async () => {
    // #given a save-data connection and the same folder feed
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, { saveData: true });
    response.resolve(
      new Response(PREFETCH_FEED, {
        status: 200,
        headers: { "Content-Type": "application/atom+xml" },
      }),
    );
    await waitFor(() => shell.app.querySelector(".books-grid") !== null);
    await Bun.sleep(1);

    // #when the folder renders
    const prefetches = shell.calls.slice(1);

    // #then no speculative request is issued
    expect(prefetches).toEqual([]);
  });

  test("prefetches the first 20 folder feeds with low priority when connection information is unavailable", async () => {
    // #given a rendered folder containing 21 subfolders and no Network Information API
    const response = deferred<Response>();
    const shell = await bootWithDelayedFeed(response.promise, undefined);
    response.resolve(
      new Response(PREFETCH_FEED, {
        status: 200,
        headers: { "Content-Type": "application/atom+xml" },
      }),
    );
    await waitFor(() => shell.app.querySelector(".books-grid") !== null);
    await Bun.sleep(1);

    // #when the shell completes the folder render
    const prefetches = shell.calls.slice(1);

    // #then it requests exactly the first 20 folder feed URLs from the fixture
    expect(prefetches).toEqual(
      Array.from({ length: 20 }, (_, index) => ({
        priority: "low",
        url: `/_catalog/prefetch/folder-${String(index + 1).padStart(2, "0")}/feed.xml`,
      })),
    );
  });

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
      renderedWithoutTrailingSlash: await runScenario("rendered-without-trailing-slash", [feed()], "http://catalog.test/fiction"),
      starting: await runScenario("starting", [
        new Response('{"status":"initializing"}', {
          status: 503,
          headers: { "Retry-After": "60" },
        }),
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
        fetchedUrls: ["/_catalog/fiction/feed.xml"],
        retryDelayMs: null,
        title: "Catalog",
      },
      renderedWithoutTrailingSlash: {
        stateClass: null,
        stateText: null,
        transientClass: null,
        transientText: null,
        homeHref: "/",
        hasGrid: true,
        fetchCount: 1,
        fetchedUrls: ["/_catalog/fiction/feed.xml"],
        retryDelayMs: null,
        title: "Catalog",
      },
      starting: {
        stateClass: null,
        stateText: null,
        transientClass: "app-state app-state--starting",
        transientText: "Server is starting, retrying in 30 s…",
        homeHref: "/",
        hasGrid: true,
        fetchCount: 2,
        fetchedUrls: ["/_catalog/fiction/feed.xml", "/_catalog/fiction/feed.xml"],
        retryDelayMs: 30_000,
        title: "Catalog",
      },
      notFound: {
        stateClass: "app-state app-state--not-found",
        stateText: "Folder not found",
        transientClass: null,
        transientText: null,
        homeHref: "/",
        hasGrid: false,
        fetchCount: 1,
        fetchedUrls: ["/_catalog/fiction/feed.xml"],
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
        fetchedUrls: ["/_catalog/fiction/feed.xml"],
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
