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
import { startConsumer } from "../../../src/effect/consumer.ts";
import type { AppContext } from "../../../src/context.ts";
import type { EventType } from "../../../src/effect/types.ts";

function createTestContext(): AppContext {
  return {
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
    dedup: { shouldProcess: () => true },
    queue: new SimpleQueue<EventType>(),
    handlers: (() => {
      const map = new Map<string, any>();
      return { get: (tag: string) => map.get(tag), register: (tag: string, handler: any) => map.set(tag, handler) };
    })(),
  };
}

describe("Queue and Consumer Integration", () => {
  test("consumer processes events from shared queue", async () => {
    const processedEvents: string[] = [];
    const controller = new AbortController();
    const ctx = createTestContext();

    ctx.handlers.register("FolderMetaSyncRequested", async (event) => {
      processedEvents.push((event as { path: string }).path);
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
});
