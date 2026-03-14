import { describe, expect, test } from "bun:test";
import { SimpleQueue } from "../../src/queue.ts";
import type { EventType } from "../../src/effect/types.ts";

class ArrayQueue<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (item: T) => void;
    reject: (reason: unknown) => void;
  }> = [];

  enqueue(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(item);
    else this.items.push(item);
  }

  async take(): Promise<T> {
    if (this.items.length > 0) return this.items.shift()!;
    return new Promise((resolve) => {
      this.waiters.push({ resolve, reject: () => {} });
    });
  }

  get size(): number {
    return this.items.length;
  }
}

const ITERATIONS = 21_000;
const MAX_KB_PER_EVENT = 1;

function getRssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function stabilize(): void {
  Bun.gc(true);
  Bun.gc(true);
  Bun.gc(true);
}

const makeEvent = (i: number): EventType => ({
  _tag: "FolderMetaSyncRequested",
  path: `/test/${i}`,
});

interface BenchResult {
  opsPerMs: number;
  kbPerEvent: number;
}

interface QueueLike {
  enqueue: (item: EventType) => void;
  take: () => Promise<EventType>;
  size: number;
}

async function benchFastPath(createQueue: () => QueueLike, iterations: number): Promise<BenchResult> {
  const queue = createQueue();
  for (let i = 0; i < 500; i++) {
    queue.enqueue(makeEvent(i));
    await queue.take();
    if (i % 50 === 0) Bun.gc(true);
  }
  stabilize();

  const beforeRss = getRssMb();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    queue.enqueue(makeEvent(i));
    await queue.take();
    if (i % 100 === 0) Bun.gc(true);
  }
  const elapsed = performance.now() - start;
  stabilize();

  return {
    opsPerMs: iterations / elapsed,
    kbPerEvent: ((getRssMb() - beforeRss) * 1024) / iterations,
  };
}

async function benchWaiterPath(createQueue: () => QueueLike, iterations: number): Promise<BenchResult> {
  const queue = createQueue();
  for (let i = 0; i < 500; i++) {
    const p = queue.take();
    queue.enqueue(makeEvent(i));
    await p;
    if (i % 50 === 0) Bun.gc(true);
  }
  stabilize();

  const beforeRss = getRssMb();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const p = queue.take();
    queue.enqueue(makeEvent(i));
    await p;
    if (i % 100 === 0) Bun.gc(true);
  }
  const elapsed = performance.now() - start;
  stabilize();

  return {
    opsPerMs: iterations / elapsed,
    kbPerEvent: ((getRssMb() - beforeRss) * 1024) / iterations,
  };
}

function logComparison(name: string, old: BenchResult, next: BenchResult): void {
  console.log(`\n  ${name}:`);
  console.log(`    ArrayQueue:    ${old.opsPerMs.toFixed(1)} ops/ms, ${old.kbPerEvent.toFixed(3)} KB/event`);
  console.log(`    UnrolledQueue: ${next.opsPerMs.toFixed(1)} ops/ms, ${next.kbPerEvent.toFixed(3)} KB/event`);
  const winner = next.kbPerEvent <= old.kbPerEvent ? "UnrolledQueue" : "ArrayQueue";
  console.log(`    Winner (RSS): ${winner}`);
}

describe("Queue Benchmark — ArrayQueue vs UnrolledQueue (R8)", () => {
  test("fast path: 21K enqueue→take cycles (R7)", async () => {
    const oldResult = await benchFastPath(() => new ArrayQueue<EventType>(), ITERATIONS);
    const newResult = await benchFastPath(() => new SimpleQueue<EventType>(), ITERATIONS);
    logComparison("Fast path (21K cycles)", oldResult, newResult);
    expect(newResult.kbPerEvent).toBeLessThan(MAX_KB_PER_EVENT);
  }, 120_000);

  test("waiter path: 21K take→enqueue cycles (R7)", async () => {
    const oldResult = await benchWaiterPath(() => new ArrayQueue<EventType>(), ITERATIONS);
    const newResult = await benchWaiterPath(() => new SimpleQueue<EventType>(), ITERATIONS);
    logComparison("Waiter path (21K cycles)", oldResult, newResult);
    expect(newResult.kbPerEvent).toBeLessThan(MAX_KB_PER_EVENT);
  }, 120_000);

  test("burst: enqueue 10K then take 10K (R3)", async () => {
    const N = 10_000;

    const oldQueue = new ArrayQueue<EventType>();
    stabilize();
    const oldBeforeRss = getRssMb();
    const oldStart = performance.now();
    for (let i = 0; i < N; i++) oldQueue.enqueue(makeEvent(i));
    for (let i = 0; i < N; i++) await oldQueue.take();
    const oldElapsed = performance.now() - oldStart;
    stabilize();
    const oldDeltaKb = (getRssMb() - oldBeforeRss) * 1024;

    const newQueue = new SimpleQueue<EventType>();
    stabilize();
    const newBeforeRss = getRssMb();
    const newStart = performance.now();
    for (let i = 0; i < N; i++) newQueue.enqueue(makeEvent(i));
    for (let i = 0; i < N; i++) await newQueue.take();
    const newElapsed = performance.now() - newStart;
    stabilize();
    const newDeltaKb = (getRssMb() - newBeforeRss) * 1024;

    console.log("\n  Burst (10K enqueue + 10K take):");
    console.log(`    ArrayQueue:    ${oldElapsed.toFixed(1)}ms, RSS delta: ${oldDeltaKb.toFixed(0)} KB`);
    console.log(`    UnrolledQueue: ${newElapsed.toFixed(1)}ms, RSS delta: ${newDeltaKb.toFixed(0)} KB`);
  }, 120_000);

  test("steady-state RSS: 50K alternating enqueue/take", async () => {
    const N = 50_000;

    const oldQueue = new ArrayQueue<EventType>();
    for (let i = 0; i < 1000; i++) {
      oldQueue.enqueue(makeEvent(i));
      await oldQueue.take();
    }
    stabilize();
    const oldBefore = getRssMb();
    for (let i = 0; i < N; i++) {
      oldQueue.enqueue(makeEvent(i));
      await oldQueue.take();
      if (i % 500 === 0) Bun.gc(true);
    }
    stabilize();
    const oldDelta = (getRssMb() - oldBefore) * 1024;

    const newQueue = new SimpleQueue<EventType>();
    for (let i = 0; i < 1000; i++) {
      newQueue.enqueue(makeEvent(i));
      await newQueue.take();
    }
    stabilize();
    const newBefore = getRssMb();
    for (let i = 0; i < N; i++) {
      newQueue.enqueue(makeEvent(i));
      await newQueue.take();
      if (i % 500 === 0) Bun.gc(true);
    }
    stabilize();
    const newDelta = (getRssMb() - newBefore) * 1024;

    console.log("\n  Steady-state (50K alternating):");
    console.log(`    ArrayQueue:    RSS delta: ${oldDelta.toFixed(0)} KB (${(oldDelta / N).toFixed(4)} KB/event)`);
    console.log(`    UnrolledQueue: RSS delta: ${newDelta.toFixed(0)} KB (${(newDelta / N).toFixed(4)} KB/event)`);
    expect(newDelta / N).toBeLessThan(MAX_KB_PER_EVENT);
  }, 300_000);
});
