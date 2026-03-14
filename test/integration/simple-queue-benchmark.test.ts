import { describe, expect, test } from "bun:test";
import { SimpleQueue } from "../../src/queue.ts";
import type { EventType } from "../../src/effect/types.ts";

const ITERATIONS = 21_000;
const MAX_SIMPLE_QUEUE_KB = 1;

function getRssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function stabilize(): void {
  Bun.gc(true);
  Bun.gc(true);
  Bun.gc(true);
}

function measureLeak(label: string, before: number, after: number, iters: number): number {
  const totalMb = after - before;
  const perIterKb = (totalMb * 1024) / iters;
  console.log(`  ${label}: ${totalMb.toFixed(2)} MB total, ${perIterKb.toFixed(2)} KB/iter (${iters} iters)`);
  return perIterKb;
}

const makeEvent = (i: number): EventType => ({
  _tag: "FolderMetaSyncRequested",
  path: `/test/${i}`,
});

describe("SimpleQueue — RSS benchmark (go/no-go gate)", () => {
  test("SimpleQueue: 21K enqueue/take cycles", async () => {
    const queue = new SimpleQueue<EventType>();

    // #given — warmup phase to stabilize allocator
    for (let i = 0; i < 500; i++) {
      queue.enqueue(makeEvent(i));
      await queue.take();
      if (i % 50 === 0) Bun.gc(true);
    }
    stabilize();

    // #when — measure RSS growth over 21K cycles
    const before = getRssMb();
    for (let i = 0; i < ITERATIONS; i++) {
      queue.enqueue(makeEvent(i));
      await queue.take();
      if (i % 100 === 0) Bun.gc(true);
    }
    stabilize();

    // #then — RSS growth must be < 1 KB/event
    const kb = measureLeak("SimpleQueue", before, getRssMb(), ITERATIONS);
    expect(kb).toBeLessThan(MAX_SIMPLE_QUEUE_KB);
  }, 120_000);

  test("SimpleQueue: 21K async take-then-enqueue (waiter path)", async () => {
    const queue = new SimpleQueue<EventType>();

    // #given — warmup
    for (let i = 0; i < 500; i++) {
      const p = queue.take();
      queue.enqueue(makeEvent(i));
      await p;
      if (i % 50 === 0) Bun.gc(true);
    }
    stabilize();

    // #when — measure the waiter path (take before enqueue)
    const before = getRssMb();
    for (let i = 0; i < ITERATIONS; i++) {
      const p = queue.take();
      queue.enqueue(makeEvent(i));
      await p;
      if (i % 100 === 0) Bun.gc(true);
    }
    stabilize();

    // #then
    const kb = measureLeak("SimpleQueue (waiter path)", before, getRssMb(), ITERATIONS);
    expect(kb).toBeLessThan(MAX_SIMPLE_QUEUE_KB);
  }, 120_000);

});
