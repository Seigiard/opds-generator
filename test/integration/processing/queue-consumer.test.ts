/**
 * Queue and Consumer integration tests.
 *
 * Verifies that:
 * - Consumer processes events from the shared SimpleQueue
 * - Queue is shared (single instance) across the AppContext
 * - AbortController-based shutdown works correctly
 */
import { describe, test, expect } from "bun:test";
import { ok } from "neverthrow";
import { SimpleQueue } from "../../../src/queue.ts";
import { buildContext } from "../../../src/context.ts";
import { getEventPath, startConsumer } from "../../../src/processing/consumer.ts";
import type { AppContext } from "../../../src/context.ts";
import type { EventType } from "../../../src/processing/types.ts";
import { spawnWithTimeout } from "../../../src/utils/process.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTestContext(): AppContext {
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
    dedup: { shouldProcess: () => true },
    queue: new SimpleQueue<EventType>(),
    handlers: (() => {
      const map = new Map<string, any>();

      return {
        get: (tag: string) => map.get(tag),
        register: (tag: string, handler: any) => map.set(tag, handler),
      };
    })(),
  };
}

describe("Queue and Consumer Integration", () => {
  test("shutdown cancels active command work without reporting a handler failure", async () => {
    // #given
    const directory = await mkdtemp(join(tmpdir(), "consumer-command-"));
    const ready = join(directory, "pid");
    const ctx = createTestContext();
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const errors: string[] = [];
    ctx.logger.error = (_tag, message) => {
      errors.push(message);
    };

    let failure = "";
    let pid: number | undefined;
    ctx.handlers.register("BookCreated", async (_event, deps) => {
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
          signal: deps.signal,
        });
      } catch (error) {
        failure = String(error);
        throw error;
      }

      return ok([{ _tag: "FolderMetaSyncRequested", path: "/test/data" }]);
    });
    const consumerTask = startConsumer(ctx, controller.signal);

    try {
      ctx.queue.enqueue({ _tag: "BookCreated", parent: "/test/files", name: "book.pdf" });
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
      expect({ failure, alive, errors }).toEqual({ failure: "Error: shutdown", alive: false, errors: [] });
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
    const ctx = createTestContext();
    const controller = new AbortController();
    ctx.handlers.register("BookCreated", async () => {
      controller.abort();

      return ok([{ _tag: "FolderMetaSyncRequested", path: "/test/data" }]);
    });
    ctx.queue.enqueue({ _tag: "BookCreated", parent: "/test/files", name: "book.pdf" });
    // #when
    await startConsumer(ctx, controller.signal);
    // #then
    expect(ctx.queue.size).toBe(0);
  });

  test("formats parent/name event paths without duplicate slashes", () => {
    const path = getEventPath({ _tag: "FolderCreated", parent: "/books/comics/", name: "Marvel" });

    expect(path).toBe("/books/comics/Marvel");
  });

  test("consumer processes events from shared queue", async () => {
    const processedEvents: string[] = [];
    const controller = new AbortController();
    const ctx = createTestContext();

    ctx.handlers.register("FolderMetaSyncRequested", async (event) => {
      if (event._tag !== "FolderMetaSyncRequested") throw new Error("Unexpected test event");
      processedEvents.push(event.path);

      return ok([]);
    });

    const consumerTask = startConsumer(ctx, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));

    ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/test/book.epub" });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processedEvents).toContain("/test/book.epub");

    controller.abort();
    await consumerTask;
  });

  test("SimpleQueue is shared — single instance across context", () => {
    const ctx = createTestContext();

    ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/shared/test1.epub" });
    expect(ctx.queue.size).toBe(1);

    ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/shared/test2.epub" });
    expect(ctx.queue.size).toBe(2);
  });

  test("buildContext queue coalesces pending folder meta-sync requests behind later work", async () => {
    const ctx = await buildContext();

    ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/shared/parent" });
    ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/shared/parent" });
    ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/shared/other" });

    expect(ctx.queue.size).toBe(2);
    expect(await ctx.queue.take()).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/shared/other",
    });
    expect(await ctx.queue.take()).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/shared/parent",
    });
  });
});
