import { describe, test, expect } from "bun:test";
import { err, ok } from "neverthrow";
import { createCatalogueProcessor, type CatalogueProcessor, type Handlers } from "../../../src/processing/catalogue-processor.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/processing/types.ts";

const deps: HandlerDeps = {
  config: { filesPath: "/test/files", dataPath: "/test/data", port: 3000, reconcileInterval: 1800 },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fs: {
    mkdir: async () => {},
    rm: async () => {},
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => false, size: 0 }),
    exists: async () => false,
    writeFile: async () => {},
    atomicWrite: async () => {},
    symlink: async () => {},
    unlink: async () => {},
  },
};

const book = (name: string): EventType => ({ _tag: "BookCreated", parent: "/test/files", name });

const refresh = (path: string): EventType => ({ _tag: "FolderMetaSyncRequested", path });

function gate() {
  let open = () => {};

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

async function settle(): Promise<void> {
  await Bun.sleep(20);
}

function recordEdges(processor: CatalogueProcessor, log: string[]): void {
  processor.onBusy(() => log.push("busy"));
  processor.onEmpty(() => log.push("empty"));
}

function startWith(handlers: Handlers) {
  const processor = createCatalogueProcessor({ deps, handlers });
  const controller = new AbortController();
  const task = processor.start(controller.signal);

  return { processor, controller, task };
}

describe("CatalogueProcessor", () => {
  test("busy and empty fire exactly once for one piece of work", async () => {
    // #given
    const edges: string[] = [];
    const { processor, controller, task } = startWith({ BookCreated: async () => ok([]) });
    recordEdges(processor, edges);
    // #when
    processor.submit(book("a.epub"));
    await settle();
    controller.abort();
    await task;
    // #then
    expect(edges).toEqual(["busy", "empty"]);
  });

  test("busy and empty fire once for a burst of work submitted together", async () => {
    // #given
    const edges: string[] = [];
    const { processor, controller, task } = startWith({ BookCreated: async () => ok([]) });
    recordEdges(processor, edges);
    // #when
    processor.submit(book("a.epub"));
    processor.submit(book("b.epub"));
    processor.submit(book("c.epub"));
    await settle();
    controller.abort();
    await task;
    // #then
    expect(edges).toEqual(["busy", "empty"]);
  });

  test("a second period of work fires a second busy and empty pair", async () => {
    // #given
    const edges: string[] = [];
    const { processor, controller, task } = startWith({ BookCreated: async () => ok([]) });
    recordEdges(processor, edges);
    processor.submit(book("a.epub"));
    await settle();
    // #when
    processor.submit(book("b.epub"));
    await settle();
    controller.abort();
    await task;
    // #then
    expect(edges).toEqual(["busy", "empty", "busy", "empty"]);
  });

  test("no empty fires between a cascade and the end of active work", async () => {
    // #given
    const edges: string[] = [];
    const seenAtCascadeStart: string[][] = [];

    const { processor, controller, task } = startWith({
      BookCreated: async () => ok([refresh("/test/data")]),
      FolderMetaSyncRequested: async () => {
        seenAtCascadeStart.push([...edges]);

        return ok([]);
      },
    });

    recordEdges(processor, edges);
    // #when
    processor.submit(book("a.epub"));
    await settle();
    controller.abort();
    await task;
    // #then
    expect({ edges, seenAtCascadeStart }).toEqual({ edges: ["busy", "empty"], seenAtCascadeStart: [["busy"]] });
  });

  test("status counts queued work as pending behind the active work", async () => {
    // #given
    const release = gate();

    const { processor, controller, task } = startWith({
      BookCreated: async () => {
        await release.promise;

        return ok([]);
      },
    });

    processor.submit(book("a.epub"));
    processor.submit(book("b.epub"));
    processor.submit(book("c.epub"));
    await settle();
    // #when
    const status = processor.status();
    release.open();
    await settle();
    controller.abort();
    await task;
    // #then
    expect(status).toEqual({ pending: 2, active: { kind: "BookCreated", path: "/test/files/a.epub" } });
  });

  test("status counts work handed to an idle consumer as pending before the consumer resumes", async () => {
    // #given
    const { processor, controller, task } = startWith({ BookCreated: async () => ok([]) });
    await settle();
    // #when
    processor.submit(book("a.epub"));
    const status = processor.status();
    await settle();
    controller.abort();
    await task;
    // #then
    expect(status).toEqual({ pending: 1, active: null });
  });

  test("a repeated folder refresh that is already pending adds no pending work", async () => {
    // #given
    const release = gate();

    const { processor, controller, task } = startWith({
      BookCreated: async () => {
        await release.promise;

        return ok([]);
      },
      FolderMetaSyncRequested: async () => ok([]),
    });

    processor.submit(book("a.epub"));
    await settle();
    processor.submit(refresh("/test/data"));
    // #when
    processor.submit(refresh("/test/data"));
    const status = processor.status();
    release.open();
    await settle();
    controller.abort();
    await task;
    // #then
    expect(status.pending).toBe(1);
  });

  test("a folder refresh requested while the same refresh is active runs once more", async () => {
    // #given
    const release = gate();
    const runs: string[] = [];

    const { processor, controller, task } = startWith({
      FolderMetaSyncRequested: async (event) => {
        runs.push(event._tag === "FolderMetaSyncRequested" ? event.path : "?");

        if (runs.length === 1) await release.promise;

        return ok([]);
      },
    });

    processor.submit(refresh("/test/data"));
    await settle();
    // #when
    processor.submit(refresh("/test/data"));
    release.open();
    await settle();
    controller.abort();
    await task;
    // #then
    expect(runs).toEqual(["/test/data", "/test/data"]);
  });

  test("no busy edge fires for work submitted after the shutdown signal", async () => {
    // #given
    const edges: string[] = [];
    const { processor, controller, task } = startWith({ BookCreated: async () => ok([]) });
    recordEdges(processor, edges);
    processor.submit(book("a.epub"));
    await settle();
    controller.abort();
    await task;
    // #when
    processor.submit(book("b.epub"));
    await settle();
    // #then
    expect(edges).toEqual(["busy", "empty"]);
  });

  test("no empty edge fires when shutdown interrupts active work", async () => {
    // #given
    const edges: string[] = [];
    const release = gate();

    const { processor, controller, task } = startWith({
      BookCreated: async () => {
        await release.promise;

        return ok([]);
      },
    });

    recordEdges(processor, edges);
    processor.submit(book("a.epub"));
    await settle();
    // #when
    controller.abort();
    release.open();
    await task;
    // #then
    expect(edges).toEqual(["busy"]);
  });

  test("shutdown drops the cascade of the active work", async () => {
    // #given
    const { processor, controller, task } = startWith({
      BookCreated: async () => {
        controller.abort();

        return ok([refresh("/test/data")]);
      },
    });

    // #when
    processor.submit(book("a.epub"));
    await task;
    // #then
    expect(processor.status().pending).toBe(0);
  });

  test("shutdown aborts the signal handed to the active handler", async () => {
    // #given
    let received: AbortSignal | undefined;

    const { processor, controller, task } = startWith({
      BookCreated: async (_event, handlerDeps) => {
        received = handlerDeps.signal;
        await new Promise<void>((resolve) => handlerDeps.signal?.addEventListener("abort", () => resolve(), { once: true }));

        return ok([]);
      },
    });

    processor.submit(book("a.epub"));
    await settle();
    // #when
    controller.abort();
    await task;
    // #then
    expect(received?.aborted).toBe(true);
  });

  test("a handler that returns an error yields no cascade and the next work runs", async () => {
    // #given
    const ran: string[] = [];

    const { processor, controller, task } = startWith({
      BookCreated: async (event) => {
        if (event._tag !== "BookCreated") throw new Error("unexpected");

        ran.push(event.name);

        return event.name === "bad.epub" ? err(new Error("boom")) : ok([]);
      },
      FolderMetaSyncRequested: async () => {
        ran.push("cascade");

        return ok([]);
      },
    });

    // #when
    processor.submit(book("bad.epub"));
    processor.submit(book("good.epub"));
    await settle();
    controller.abort();
    await task;
    // #then
    expect(ran).toEqual(["bad.epub", "good.epub"]);
  });

  test("a handler that throws yields no cascade, the next work runs and empty still fires", async () => {
    // #given
    const edges: string[] = [];
    const ran: string[] = [];

    const { processor, controller, task } = startWith({
      BookCreated: async (event) => {
        if (event._tag !== "BookCreated") throw new Error("unexpected");

        ran.push(event.name);

        if (event.name === "bad.epub") throw new Error("boom");

        return ok([]);
      },
    });

    recordEdges(processor, edges);
    // #when
    processor.submit(book("bad.epub"));
    processor.submit(book("good.epub"));
    await settle();
    const status = processor.status();
    controller.abort();
    await task;
    // #then
    expect({ ran, edges, status }).toEqual({
      ran: ["bad.epub", "good.epub"],
      edges: ["busy", "empty"],
      status: { pending: 0, active: null },
    });
  });

  test("work with no registered handler is skipped and the processor still goes empty", async () => {
    // #given
    const edges: string[] = [];
    const { processor, controller, task } = startWith({});
    recordEdges(processor, edges);
    // #when
    processor.submit(book("a.epub"));
    await settle();
    controller.abort();
    await task;
    // #then
    expect(edges).toEqual(["busy", "empty"]);
  });

  test("an unsubscribed listener hears no further edges", async () => {
    // #given
    const edges: string[] = [];
    const { processor, controller, task } = startWith({ BookCreated: async () => ok([]) });
    const off = processor.onBusy(() => edges.push("busy"));
    off();
    // #when
    processor.submit(book("a.epub"));
    await settle();
    controller.abort();
    await task;
    // #then
    expect(edges).toEqual([]);
  });
});
