import { describe, expect, test } from "bun:test";
import { Effect, Fiber, ManagedRuntime } from "effect";
import { startConsumer } from "../../src/effect/consumer.ts";
import { EventQueueService, HandlerRegistry, LiveLayer } from "../../src/effect/services.ts";
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

describe("Effect runtime memory leak isolation", () => {
  test("bare Effect.runPromise (no runtime, no queue)", async () => {
    const op = async () => {
      await Effect.runPromise(Effect.sync(() => 42));
    };
    await warmup(op);

    stabilize();
    const before = getRssMb();
    for (let i = 0; i < ITERATIONS; i++) {
      await op();
      Bun.gc(true);
    }
    stabilize();

    const kb = measureLeak("Effect.runPromise(sync)", before, getRssMb(), ITERATIONS);
    expect(kb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("ManagedRuntime.runPromise (no queue)", async () => {
    const rt = ManagedRuntime.make(LiveLayer);
    const op = async () => {
      await rt.runPromise(Effect.sync(() => 42));
    };
    await warmup(op);

    stabilize();
    const before = getRssMb();
    for (let i = 0; i < ITERATIONS; i++) {
      await op();
      Bun.gc(true);
    }
    stabilize();

    const kb = measureLeak("runtime.runPromise(sync)", before, getRssMb(), ITERATIONS);
    await rt.dispose();
    expect(kb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test.skip("ManagedRuntime.runPromise with Effect.gen (mimalloc page retention — oven-sh/bun#21560)", async () => {
    const rt = ManagedRuntime.make(LiveLayer);
    const op = async () => {
      await rt.runPromise(
        Effect.gen(function* () {
          yield* Effect.void;
          return 42;
        }),
      );
    };
    await warmup(op);

    stabilize();
    const before = getRssMb();
    for (let i = 0; i < ITERATIONS; i++) {
      await op();
      Bun.gc(true);
    }
    stabilize();

    const kb = measureLeak("runtime.runPromise(gen)", before, getRssMb(), ITERATIONS);
    await rt.dispose();
    expect(kb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test.skip("ManagedRuntime + Queue.offer/take (mimalloc page retention — oven-sh/bun#21560)", async () => {
    const rt = ManagedRuntime.make(LiveLayer);

    const enqueueAndConsume = () =>
      rt.runPromise(
        Effect.gen(function* () {
          const queue = yield* EventQueueService;
          yield* queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/test" });
          yield* queue.take();
        }),
      );

    await warmup(enqueueAndConsume);

    stabilize();
    const before = getRssMb();
    for (let i = 0; i < ITERATIONS; i++) {
      await enqueueAndConsume();
      Bun.gc(true);
    }
    stabilize();

    const kb = measureLeak("runtime+queue(offer+take)", before, getRssMb(), ITERATIONS);
    await rt.dispose();
    expect(kb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test.skip("ManagedRuntime + Consumer fiber + enqueue (mimalloc page retention — oven-sh/bun#21560)", async () => {
    const rt = ManagedRuntime.make(LiveLayer);
    let processed = 0;

    await rt.runPromise(
      Effect.gen(function* () {
        const registry = yield* HandlerRegistry;
        registry.register("FolderMetaSyncRequested", () =>
          Effect.sync(() => {
            processed++;
            return [] as readonly EventType[];
          }),
        );
      }),
    );

    const fiber = rt.runFork(startConsumer);
    await new Promise((r) => setTimeout(r, 50));

    const enqueue = (i: number) =>
      rt.runPromise(
        Effect.gen(function* () {
          const queue = yield* EventQueueService;
          yield* queue.enqueue({ _tag: "FolderMetaSyncRequested", path: `/test/${i}` });
        }),
      );

    await warmup(async () => {
      await enqueue(0);
      await new Promise((r) => setTimeout(r, 5));
    });

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await enqueue(i);
      if (i % 50 === 0) {
        await new Promise((r) => setTimeout(r, 50));
        Bun.gc(true);
      }
    }

    await new Promise((r) => setTimeout(r, 500));
    stabilize();

    const kb = measureLeak("runtime+consumer+enqueue", before, getRssMb(), ITERATIONS);
    console.log(`  processed: ${processed}`);

    await rt.runPromise(Fiber.interrupt(fiber));
    await rt.dispose();
    expect(kb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);
});
