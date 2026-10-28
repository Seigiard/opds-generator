import { describe, expect, test } from "bun:test";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import type { FeedModel } from "../../../src/render/feed-model.ts";

const ROOT_FEED = await Bun.file(new URL("../../fixtures/feeds/root.xml", import.meta.url)).text();

const PREFETCH_FEED = await Bun.file(new URL("../../fixtures/feeds/prefetch-folders.xml", import.meta.url)).text();

const FOLDER_LOAD_MODULE = "../../../ui/gridnav/folder-load.ts";

type ShellState =
  | { kind: "skeleton" }
  | { kind: "starting"; retryInSeconds: number }
  | { kind: "not-found" }
  | { kind: "http-error"; status: number }
  | { kind: "error"; message?: string }
  | { kind: "ready"; model: FeedModel };

type FolderLoadModule = {
  readonly folderFeedsToPrefetch: (model: FeedModel, saveData: boolean) => string[];
  readonly loadFolder: (
    folderPath: string,
    deps: { fetch: (url: string) => Promise<Response>; parse: (xml: string) => FeedModel; sleep: (milliseconds: number) => Promise<void> },
  ) => AsyncIterable<ShellState>;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: T) => void;
};

type SleepClock = {
  readonly delays: number[];
  readonly release: (index: number) => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
};

type DeferredResponseBody = {
  readonly deliver: (body: string) => void;
  readonly response: Response;
};

type TerminalScenario = {
  readonly expected: Exclude<ShellState, { kind: "skeleton" } | { kind: "starting" }>;
  readonly fetch: () => Promise<Response>;
  readonly name: string;
  readonly parse: (xml: string) => FeedModel;
};

function deferred<T>(): Deferred<T> {
  let reject!: (error: Error) => void;
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });

  return { promise, reject, resolve };
}

function sleepClock(): SleepClock {
  const delays: number[] = [];
  const waits: Array<Deferred<void>> = [];

  return {
    delays,
    release: (index) => waits[index]?.resolve(),
    sleep: (milliseconds) => {
      const wait = deferred<void>();
      delays.push(milliseconds);
      waits.push(wait);

      return wait.promise;
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (condition()) return;
    await Promise.resolve();
  }

  throw new Error("Timed out waiting for the folder loader");
}

function folderLoader(): Promise<FolderLoadModule> {
  return import(FOLDER_LOAD_MODULE);
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
    response: new Response(body, { status: 200 }),
  };
}

describe("loadFolder", () => {
  test("emits ready directly when the complete first response arrives before the loading delay", async () => {
    // #given a successful feed and a loading delay that has not elapsed
    const { loadFolder } = await folderLoader();
    const clock = sleepClock();
    const requests: string[] = [];

    // #when the first response and its body resolve immediately
    const states = await Array.fromAsync(
      loadFolder("/fiction/", {
        fetch: async (url) => {
          requests.push(url);

          return new Response(ROOT_FEED, { status: 200 });
        },
        parse: parseFeed,
        sleep: clock.sleep,
      }),
    );

    // #then the shell receives the parsed folder without a loading state
    expect({ delays: clock.delays, requests, states }).toEqual({
      delays: [300],
      requests: ["/_catalog/fiction/feed.xml"],
      states: [{ kind: "ready", model: parseFeed(ROOT_FEED) }],
    });
  });

  test("emits skeleton then ready when the first response is slower than the loading delay", async () => {
    // #given a response that has not arrived and a controllable clock
    const { loadFolder } = await folderLoader();
    const response = deferred<Response>();
    const clock = sleepClock();
    const states = loadFolder("/fiction/", { fetch: () => response.promise, parse: parseFeed, sleep: clock.sleep })[Symbol.asyncIterator]();

    // #when the delay fires before the response, then the response arrives
    const skeleton = states.next();
    await waitFor(() => clock.delays[0] === 300);
    clock.release(0);
    const first = await skeleton;
    response.resolve(new Response(ROOT_FEED, { status: 200 }));
    const second = await states.next();

    // #then loading feedback precedes the parsed folder exactly once
    expect({ first, second }).toEqual({
      first: { done: false, value: { kind: "skeleton" } },
      second: { done: false, value: { kind: "ready", model: parseFeed(ROOT_FEED) } },
    });
  });

  test("emits skeleton while the first response body is still streaming", async () => {
    // #given response headers without their body and a controllable clock
    const { loadFolder } = await folderLoader();
    const streamed = responseWithDeferredBody();
    const clock = sleepClock();

    const states = loadFolder("/fiction/", {
      fetch: async () => streamed.response,
      parse: parseFeed,
      sleep: clock.sleep,
    })[Symbol.asyncIterator]();

    // #when the loading delay fires before the body is delivered
    const skeleton = states.next();
    await waitFor(() => clock.delays[0] === 300);
    clock.release(0);
    const first = await skeleton;
    streamed.deliver(ROOT_FEED);
    const second = await states.next();

    // #then the loading state remains until parsing can complete
    expect({ first, second }).toEqual({
      first: { done: false, value: { kind: "skeleton" } },
      second: { done: false, value: { kind: "ready", model: parseFeed(ROOT_FEED) } },
    });
  });

  const retryScenarios = [
    { header: null, name: "missing", seconds: 5 },
    { header: "-1", name: "negative", seconds: 5 },
    { header: "later", name: "non-numeric", seconds: 5 },
    { header: "31", name: "over-limit", seconds: 30 },
  ];

  for (const scenario of retryScenarios) {
    test(`retries a 503 with the ${scenario.name} Retry-After value`, async () => {
      // #given a starting response followed by a successful folder response
      const { loadFolder } = await folderLoader();
      const delays: number[] = [];
      let calls = 0;

      // #when the loader receives the configured Retry-After value
      const states = await Array.fromAsync(
        loadFolder("/fiction/", {
          fetch: async () => {
            calls += 1;

            return calls === 1
              ? new Response("", { status: 503, headers: scenario.header ? { "Retry-After": scenario.header } : {} })
              : new Response(ROOT_FEED, { status: 200 });
          },
          parse: parseFeed,
          sleep: async (milliseconds) => {
            delays.push(milliseconds);

            if (milliseconds !== 300) return;
            await new Promise<void>(() => undefined);
          },
        }),
      );

      // #then it announces the independently specified retry delay before the ready state
      expect({ calls, delays, states }).toEqual({
        calls: 2,
        delays: [300, scenario.seconds * 1000],
        states: [
          { kind: "starting", retryInSeconds: scenario.seconds },
          { kind: "ready", model: parseFeed(ROOT_FEED) },
        ],
      });
    });
  }

  test("continues retrying after more than one 503 response", async () => {
    // #given two starting responses before a successful folder response
    const { loadFolder } = await folderLoader();
    const delays: number[] = [];
    let calls = 0;

    // #when each retry delay completes
    const states = await Array.fromAsync(
      loadFolder("/fiction/", {
        fetch: async () => {
          calls += 1;

          return calls === 3
            ? new Response(ROOT_FEED, { status: 200 })
            : new Response("", { status: 503, headers: { "Retry-After": "1" } });
        },
        parse: parseFeed,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);

          if (milliseconds !== 300) return;
          await new Promise<void>(() => undefined);
        },
      }),
    );

    // #then every 503 yields a retry state and the sequence later reaches ready
    expect({ calls, delays, states }).toEqual({
      calls: 3,
      delays: [300, 1000, 1000],
      states: [
        { kind: "starting", retryInSeconds: 1 },
        { kind: "starting", retryInSeconds: 1 },
        { kind: "ready", model: parseFeed(ROOT_FEED) },
      ],
    });
  });

  test("does not emit a skeleton after starting while its retry is pending", async () => {
    // #given a starting response, a ready retry, and a clock whose first delay can fire during the retry
    const { loadFolder } = await folderLoader();
    const clock = sleepClock();
    let calls = 0;

    const states = loadFolder("/fiction/", {
      fetch: async () => {
        calls += 1;

        return calls === 1 ? new Response("", { status: 503, headers: { "Retry-After": "1" } }) : new Response(ROOT_FEED, { status: 200 });
      },
      parse: parseFeed,
      sleep: clock.sleep,
    })[Symbol.asyncIterator]();

    // #when the initial delay elapses while the retry delay is still pending, then the retry completes
    const starting = await states.next();
    const ready = states.next();
    await waitFor(() => clock.delays.length === 2);
    clock.release(0);
    clock.release(1);
    const result = { done: await states.next(), ready: await ready, starting };

    // #then the retry progresses directly from its starting status to the folder without a late skeleton
    expect(result).toEqual({
      done: { done: true, value: undefined },
      ready: { done: false, value: { kind: "ready", model: parseFeed(ROOT_FEED) } },
      starting: { done: false, value: { kind: "starting", retryInSeconds: 1 } },
    });
  });

  const terminalScenarios: readonly TerminalScenario[] = [
    {
      expected: { kind: "ready", model: parseFeed(ROOT_FEED) },
      fetch: async () => new Response(ROOT_FEED, { status: 200 }),
      name: "a fast ready response",
      parse: parseFeed,
    },
    {
      expected: { kind: "not-found" },
      fetch: async () => new Response("", { status: 404 }),
      name: "a not-found response",
      parse: parseFeed,
    },
    {
      expected: { kind: "http-error", status: 500 },
      fetch: async () => new Response("", { status: 500 }),
      name: "an HTTP error response",
      parse: parseFeed,
    },
    {
      expected: { kind: "error", message: "Network offline" },
      fetch: async () => Promise.reject(new Error("Network offline")),
      name: "a thrown fetch error",
      parse: parseFeed,
    },
    {
      expected: { kind: "error", message: "Invalid OPDS feed" },
      fetch: async () => new Response(ROOT_FEED, { status: 200 }),
      name: "a thrown parse error",
      parse: () => {
        throw new Error("Invalid OPDS feed");
      },
    },
  ];

  for (const scenario of terminalScenarios) {
    test(`does not emit a late skeleton after ${scenario.name}`, async () => {
      // #given a terminal first result and a loading delay that can elapse afterward
      const { loadFolder } = await folderLoader();
      const clock = sleepClock();
      const states = loadFolder("/fiction/", { ...scenario, sleep: clock.sleep })[Symbol.asyncIterator]();

      // #when the terminal state arrives before the first delay, then that delay elapses while the iterator drains
      const terminal = await states.next();
      await waitFor(() => clock.delays[0] === 300);
      clock.release(0);
      const done = await states.next();

      // #then the terminal state remains the only state and no skeleton follows it
      expect({ done, terminal }).toEqual({
        done: { done: true, value: undefined },
        terminal: { done: false, value: scenario.expected },
      });
    });
  }

  test("emits not-found for a 404 response", async () => {
    // #given a missing folder response
    const { loadFolder } = await folderLoader();

    // #when the folder feed is requested
    const states = await Array.fromAsync(
      loadFolder("/missing/", {
        fetch: async () => new Response("", { status: 404 }),
        parse: parseFeed,
        sleep: () => new Promise(() => undefined),
      }),
    );

    // #then the sequence ends at the not-found state
    expect(states).toEqual([{ kind: "not-found" }]);
  });

  test("emits the HTTP status for a non-404 unsuccessful response", async () => {
    // #given a server error response
    const { loadFolder } = await folderLoader();

    // #when the folder feed is requested
    const states = await Array.fromAsync(
      loadFolder("/fiction/", {
        fetch: async () => new Response("", { status: 500 }),
        parse: parseFeed,
        sleep: () => new Promise(() => undefined),
      }),
    );

    // #then the status is preserved for the shell renderer
    expect(states).toEqual([{ kind: "http-error", status: 500 }]);
  });

  test("emits an error with the thrown fetch message", async () => {
    // #given a fetch dependency that cannot reach the folder feed
    const { loadFolder } = await folderLoader();

    // #when the dependency throws
    const states = await Array.fromAsync(
      loadFolder("/fiction/", {
        fetch: async () => Promise.reject(new Error("Network offline")),
        parse: parseFeed,
        sleep: () => new Promise(() => undefined),
      }),
    );

    // #then its user-safe Error message becomes the terminal shell state
    expect(states).toEqual([{ kind: "error", message: "Network offline" }]);
  });

  test("emits an error with the thrown parse message", async () => {
    // #given a successful response and a parser that rejects its body
    const { loadFolder } = await folderLoader();

    // #when parsing throws
    const states = await Array.fromAsync(
      loadFolder("/fiction/", {
        fetch: async () => new Response(ROOT_FEED, { status: 200 }),
        parse: () => {
          throw new Error("Invalid OPDS feed");
        },
        sleep: () => new Promise(() => undefined),
      }),
    );

    // #then the parse failure becomes the terminal shell state
    expect(states).toEqual([{ kind: "error", message: "Invalid OPDS feed" }]);
  });
});

describe("folderFeedsToPrefetch", () => {
  test("returns the first 20 catalog folder feed URLs in model order", async () => {
    // #given a fixture with 21 folders plus invalid folder-like and book entries
    const { folderFeedsToPrefetch } = await folderLoader();
    const fixture = parseFeed(PREFETCH_FEED);

    const model: FeedModel = {
      ...fixture,
      entries: [
        { ...fixture.entries[0]!, href: "/unrelated/feed.xml" },
        { ...fixture.entries[1]!, href: "/_catalog/not-a-feed.xml" },
        { ...fixture.entries[2]!, kind: "book", href: "/_catalog/book/feed.xml" },
        ...fixture.entries,
      ],
    };

    // #when prefetch candidates are selected
    const urls = folderFeedsToPrefetch(model, false);

    // #then only the first 20 valid catalog folder feeds remain in their feed order
    expect(urls).toEqual(
      Array.from({ length: 20 }, (_, index) => `/_catalog/prefetch/folder-${String(index + 1).padStart(2, "0")}/feed.xml`),
    );
  });

  test("returns no prefetch URLs when the connection saves data", async () => {
    // #given a folder feed with eligible folder links
    const { folderFeedsToPrefetch } = await folderLoader();
    const model = parseFeed(PREFETCH_FEED);

    // #when the browser requests reduced data use
    const urls = folderFeedsToPrefetch(model, true);

    // #then speculative folder requests are suppressed
    expect(urls).toEqual([]);
  });
});
