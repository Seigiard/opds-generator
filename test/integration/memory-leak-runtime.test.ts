import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { SimpleQueue } from "../../src/queue.ts";
import { startConsumer } from "../../src/effect/consumer.ts";
import type { AppContext } from "../../src/context.ts";
import type { EventType } from "../../src/effect/types.ts";

const ITERATIONS = 500;
const MAX_LEAK_KB = 1;

function getRssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function stabilize(): void {
  Bun.gc(true);
  Bun.gc(true);
  Bun.gc(true);
}

async function warmup(fn: () => Promise<void>, count = 200): Promise<void> {
  for (let i = 0; i < count; i++) {
    await fn();
    if (i % 20 === 0) Bun.gc(true);
  }
  stabilize();
}

function measureLeak(label: string, before: number, after: number, iters: number): number {
  const totalMb = after - before;
  const perIterKb = (totalMb * 1024) / iters;
  console.log(`  ${label}: ${totalMb.toFixed(2)} MB total, ${perIterKb.toFixed(2)} KB/iter (${iters} iters)`);
  return perIterKb;
}

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
    handlers: {
      get: () => undefined,
      register: () => {},
    },
  };
}

describe("Runtime memory leak isolation (post-Effect migration)", () => {
  test("SimpleQueue enqueue/take cycle", async () => {
    const queue = new SimpleQueue<EventType>();
    const op = async () => {
      queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/test" });
      await queue.take();
    };
    await warmup(op);

    stabilize();
    const before = getRssMb();
    for (let i = 0; i < ITERATIONS; i++) {
      await op();
      Bun.gc(true);
    }
    stabilize();

    const kb = measureLeak("SimpleQueue(offer+take)", before, getRssMb(), ITERATIONS);
    expect(kb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("Consumer + enqueue cycle", async () => {
    const ctx = createTestContext();
    let processed = 0;

    ctx.handlers.get = (tag) => {
      if (tag === "FolderMetaSyncRequested") {
        return async () => {
          processed++;
          return ok([] as readonly EventType[]);
        };
      }
      return undefined;
    };

    const controller = new AbortController();
    const consumerTask = startConsumer(ctx, controller.signal);
    await new Promise((r) => setTimeout(r, 50));

    const enqueue = () => {
      ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/test" });
    };

    await warmup(async () => {
      enqueue();
      await new Promise((r) => setTimeout(r, 5));
    });

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      enqueue();
      if (i % 50 === 0) {
        await new Promise((r) => setTimeout(r, 50));
        Bun.gc(true);
      }
    }

    await new Promise((r) => setTimeout(r, 500));
    stabilize();

    const kb = measureLeak("consumer+enqueue", before, getRssMb(), ITERATIONS);
    console.log(`  processed: ${processed}`);

    controller.abort();
    await consumerTask;
    expect(kb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);
});
