/**
 * Catalogue processor integration tests.
 *
 * Verifies that:
 * - The processor runs submitted work through its fixed handler registry
 * - Shutdown cancels active command work and drops cascades
 * - Pending folder refreshes coalesce behind later work
 */
import { describe, test, expect } from "bun:test";
import { ok } from "neverthrow";
import { getEventPath } from "../../../src/processing/catalogue-processor.ts";
import { createEffectCatalogueProcessor } from "../../../src/processing/catalogue-processor-effect.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import { spawnWithTimeout } from "../../../src/utils/process.ts";
import { toEffectTestHandlers, type TestHandlers } from "../../helpers/effect-test-handlers.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTestDeps(): Omit<HandlerDeps, "signal"> {
  return {
    config: {
      filesPath: "/test/files",
      dataPath: "/test/data",
      port: 3000,
      reconcileInterval: 1800,
    },
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
}

describe("Catalogue processor integration", () => {
  test("shutdown cancels active command work without reporting a handler failure", async () => {
    // #given
    const directory = await mkdtemp(join(tmpdir(), "consumer-command-"));
    const ready = join(directory, "pid");
    const deps = createTestDeps();
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const errors: string[] = [];
    deps.logger.error = (_tag, message) => {
      errors.push(message);
    };

    let pid: number | undefined;
    let commandFailure: unknown;

    const handlers: TestHandlers = {
      BookCreated: async (_event, handlerDeps) => {
        try {
          await spawnWithTimeout({
            command: [
              process.execPath,
              "-e",
              `
              require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));
              setInterval(() => {}, 100);
            `,
            ],
            timeout: 3000,
            signal: handlerDeps.signal,
          });
        } catch (error) {
          commandFailure = error;
          throw error;
        }

        return ok([{ _tag: "FolderMetaSyncRequested", path: "/test/data" }]);
      },
    };

    const processor = createEffectCatalogueProcessor({ deps, handlers: toEffectTestHandlers(handlers) });
    const consumerTask = processor.start(controller.signal);

    try {
      processor.submit({ _tag: "BookCreated", parent: "/test/files", name: "book.pdf" });
      const deadline = Date.now() + 3000;

      while (!(await Bun.file(ready).exists())) {
        if (Date.now() >= deadline) throw new Error("Child did not become ready");
        await Bun.sleep(10);
      }

      pid = Number(await Bun.file(ready).text());
      // #when
      controller.abort(reason);
      await consumerTask;
      let alive = true;

      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }

      // #then
      expect({ alive, errors }).toEqual({ alive: false, errors: [] });
      expect(commandFailure).toEqual(expect.objectContaining({ name: "AbortError" }));
    } finally {
      controller.abort(reason);
      await consumerTask;

      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The command has normally been reaped by the consumer.
        }
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  test("shutdown discards cascades returned by an active handler", async () => {
    // #given
    const controller = new AbortController();

    const processor = createEffectCatalogueProcessor({
      deps: createTestDeps(),
      handlers: toEffectTestHandlers({
        BookCreated: async () => {
          controller.abort();

          return ok([{ _tag: "FolderMetaSyncRequested", path: "/test/data" }]);
        },
      }),
    });

    processor.submit({ _tag: "BookCreated", parent: "/test/files", name: "book.pdf" });
    // #when
    await processor.start(controller.signal);
    // #then
    expect(processor.status()).toEqual({ pending: 0, active: null });
  });

  test("formats parent/name event paths without duplicate slashes", () => {
    const path = getEventPath({ _tag: "FolderCreated", parent: "/books/comics/", name: "Marvel" });

    expect(path).toBe("/books/comics/Marvel");
  });

  test("processor runs submitted work through the registry", async () => {
    // #given
    const processedEvents: string[] = [];
    const controller = new AbortController();

    const processor = createEffectCatalogueProcessor({
      deps: createTestDeps(),
      handlers: toEffectTestHandlers({
        FolderMetaSyncRequested: async (event) => {
          if (event._tag !== "FolderMetaSyncRequested") throw new Error("Unexpected test event");
          processedEvents.push(event.path);

          return ok([]);
        },
      }),
    });

    const consumerTask = processor.start(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // #when
    processor.submit({ _tag: "FolderMetaSyncRequested", path: "/test/book.epub" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await consumerTask;
    // #then
    expect(processedEvents).toEqual(["/test/book.epub"]);
  });

  test("pending folder refreshes coalesce behind later work", async () => {
    // #given
    const order: string[] = [];
    const controller = new AbortController();
    let release = () => {};

    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const processor = createEffectCatalogueProcessor({
      deps: createTestDeps(),
      handlers: toEffectTestHandlers({
        BookCreated: async () => {
          await blocked;

          return ok([]);
        },
        FolderMetaSyncRequested: async (event) => {
          if (event._tag !== "FolderMetaSyncRequested") throw new Error("Unexpected test event");
          order.push(event.path);

          return ok([]);
        },
      }),
    });

    const consumerTask = processor.start(controller.signal);
    processor.submit({ _tag: "BookCreated", parent: "/test/files", name: "block.epub" });
    await Bun.sleep(20);
    // #when
    processor.submit({ _tag: "FolderMetaSyncRequested", path: "/shared/parent" });
    processor.submit({ _tag: "FolderMetaSyncRequested", path: "/shared/parent" });
    processor.submit({ _tag: "FolderMetaSyncRequested", path: "/shared/other" });
    const pendingBeforeRelease = processor.status().pending;
    release();
    await Bun.sleep(50);
    controller.abort();
    await consumerTask;
    // #then
    expect({ pendingBeforeRelease, order }).toEqual({
      pendingBeforeRelease: 2,
      order: ["/shared/other", "/shared/parent"],
    });
  });
});
