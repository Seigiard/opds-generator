import { describe, expect, test } from "bun:test";
import { CHUNK_SIZE, QueueChunk, SimpleQueue, UnrolledQueue } from "../../src/queue.ts";

describe("QueueChunk", () => {
  test("push and shift in FIFO order", () => {
    // #given
    const chunk = new QueueChunk<number>();

    // #when
    chunk.push(1);
    chunk.push(2);
    chunk.push(3);

    // #then
    expect(chunk.shift()).toBe(1);
    expect(chunk.shift()).toBe(2);
    expect(chunk.shift()).toBe(3);
  });

  test("push returns false when full", () => {
    // #given
    const chunk = new QueueChunk<number>();
    for (let i = 0; i < CHUNK_SIZE; i++) chunk.push(i);

    // #then
    expect(chunk.push(9999)).toBe(false);
  });

  test("shift returns undefined when empty", () => {
    expect(new QueueChunk<number>().shift()).toBeUndefined();
  });

  test("length tracks buffered items", () => {
    const chunk = new QueueChunk<number>();
    expect(chunk.length).toBe(0);
    chunk.push(1);
    expect(chunk.length).toBe(1);
    chunk.shift();
    expect(chunk.length).toBe(0);
  });

  test("nulls slot after shift (R9 — GC retention)", () => {
    // #given
    const chunk = new QueueChunk<{ data: string }>();
    chunk.push({ data: "test" });

    // #when
    chunk.shift();

    // #then
    expect(chunk.buffer[0]).toBeUndefined();
  });

  test("reset clears indices, next pointer, and buffer", () => {
    // #given
    const chunk = new QueueChunk<number>();
    chunk.push(1);
    chunk.push(2);
    chunk.next = new QueueChunk<number>();

    // #when
    chunk.reset();

    // #then
    expect(chunk.readIndex).toBe(0);
    expect(chunk.writeIndex).toBe(0);
    expect(chunk.next).toBeNull();
    expect(chunk.buffer[0]).toBeUndefined();
    expect(chunk.buffer[1]).toBeUndefined();
  });
});

describe("UnrolledQueue", () => {
  test("push and shift in FIFO order", () => {
    const q = new UnrolledQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.shift()).toBe(1);
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBe(3);
  });

  test("shift returns undefined when empty", () => {
    expect(new UnrolledQueue<number>().shift()).toBeUndefined();
  });

  test("length tracks total items across chunks", () => {
    const q = new UnrolledQueue<number>();
    expect(q.length).toBe(0);
    q.push(1);
    expect(q.length).toBe(1);
    q.shift();
    expect(q.length).toBe(0);
  });

  test("FIFO preserved across chunk boundary (R6)", () => {
    // #given
    const q = new UnrolledQueue<number>();
    const total = CHUNK_SIZE + 100;

    // #when
    for (let i = 0; i < total; i++) q.push(i);

    // #then
    for (let i = 0; i < total; i++) expect(q.shift()).toBe(i);
    expect(q.length).toBe(0);
  });

  test("large burst — 10K items preserve order", () => {
    const q = new UnrolledQueue<number>();
    const N = 10_000;
    for (let i = 0; i < N; i++) q.push(i);
    for (let i = 0; i < N; i++) expect(q.shift()).toBe(i);
    expect(q.length).toBe(0);
  });

  test("interleaved push/shift across chunk boundaries", () => {
    const q = new UnrolledQueue<number>();
    for (let round = 0; round < 3; round++) {
      const base = round * CHUNK_SIZE;
      for (let i = 0; i < CHUNK_SIZE; i++) q.push(base + i);
      for (let i = 0; i < CHUNK_SIZE; i++) expect(q.shift()).toBe(base + i);
    }
    expect(q.length).toBe(0);
  });

  test("single chunk resets after full drain for reuse", () => {
    const q = new UnrolledQueue<number>();
    for (let i = 0; i < CHUNK_SIZE; i++) q.push(i);
    for (let i = 0; i < CHUNK_SIZE; i++) q.shift();
    q.push(999);
    expect(q.shift()).toBe(999);
  });

  test("spare node recycling — drain and refill (R4)", () => {
    const q = new UnrolledQueue<number>();
    for (let i = 0; i < CHUNK_SIZE + 1; i++) q.push(i);
    for (let i = 0; i < CHUNK_SIZE + 1; i++) q.shift();
    expect(q.length).toBe(0);
    for (let i = 0; i < CHUNK_SIZE + 1; i++) q.push(i);
    for (let i = 0; i < CHUNK_SIZE + 1; i++) expect(q.shift()).toBe(i);
  });
});

describe("SimpleQueue", () => {
  test("FIFO ordering (spec #1)", async () => {
    const q = new SimpleQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    expect(await q.take()).toBe(1);
    expect(await q.take()).toBe(2);
    expect(await q.take()).toBe(3);
  });

  test("enqueueMany preserves insertion order (spec #2)", async () => {
    const q = new SimpleQueue<number>();
    q.enqueueMany([10, 20, 30]);
    expect(await q.take()).toBe(10);
    expect(await q.take()).toBe(20);
    expect(await q.take()).toBe(30);
  });

  test("take blocks until item enqueued — waiter path (spec #3)", async () => {
    const q = new SimpleQueue<number>();
    const promise = q.take();
    q.enqueue(42);
    expect(await promise).toBe(42);
  });

  test("multiple waiters resolved in FIFO order (spec #4)", async () => {
    const q = new SimpleQueue<number>();
    const p1 = q.take();
    const p2 = q.take();
    const p3 = q.take();
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(await p3).toBe(3);
  });

  test("take rejects on AbortSignal abort (spec #5)", async () => {
    const q = new SimpleQueue<number>();
    const controller = new AbortController();
    const promise = q.take(controller.signal);
    controller.abort(new Error("cancelled"));
    expect(promise).rejects.toThrow("cancelled");
  });

  test("aborted waiter does not consume future items (spec #6)", async () => {
    // #given
    const q = new SimpleQueue<number>();
    const controller = new AbortController();
    const abortedPromise = q.take(controller.signal);
    controller.abort(new Error("cancelled"));
    expect(abortedPromise).rejects.toThrow("cancelled");

    // #when
    q.enqueue(42);

    // #then
    expect(q.size).toBe(1);
    expect(await q.take()).toBe(42);
  });

  test("size reflects buffered items only, not waiters (spec #7)", async () => {
    const q = new SimpleQueue<number>();
    expect(q.size).toBe(0);
    q.enqueue(1);
    expect(q.size).toBe(1);

    const p1 = q.take();
    expect(q.size).toBe(0);

    const p2 = q.take();
    expect(q.size).toBe(0);

    q.enqueue(2);
    await p1;
    await p2;
  });

  test("chunk boundary crossing preserves FIFO (spec #8)", async () => {
    const q = new SimpleQueue<number>();
    const total = CHUNK_SIZE * 2 + 100;
    for (let i = 0; i < total; i++) q.enqueue(i);
    for (let i = 0; i < total; i++) expect(await q.take()).toBe(i);
  });

  test("large burst — 10K items (spec #10)", async () => {
    const q = new SimpleQueue<number>();
    const N = 10_000;
    for (let i = 0; i < N; i++) q.enqueue(i);
    expect(q.size).toBe(N);
    for (let i = 0; i < N; i++) expect(await q.take()).toBe(i);
    expect(q.size).toBe(0);
  });

  test("interleaved enqueue/take (spec #11)", async () => {
    const q = new SimpleQueue<number>();
    for (let i = 0; i < CHUNK_SIZE * 3; i++) {
      q.enqueue(i);
      expect(await q.take()).toBe(i);
    }
  });

  test("empty queue take returns pending promise (spec #12)", async () => {
    const q = new SimpleQueue<number>();
    const result = q.take();
    expect(result).toBeInstanceOf(Promise);
    q.enqueue(0);
    await result;
  });

  test("already-aborted signal rejects immediately (spec #13, R5)", async () => {
    const q = new SimpleQueue<number>();
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    expect(q.take(controller.signal)).rejects.toThrow("pre-aborted");
  });
});
