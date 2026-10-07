import { describe, test, expect, beforeAll } from "bun:test";
import {
  MAX_CHAIN_LEAK_KB,
  MAX_OBJECTS_PER_ITER,
  MAX_RUNTIME_LEAK_KB,
  QUEUE_EVENTS_PER_OP,
  retainedKbPerIter,
  runProbe,
} from "../helpers/run-leak-probe.ts";

// The memory gates pass on clean code; this proves they can still go red. The probe keeps
// a known allocation alive per measured operation, independent of the code under test,
// on the noisiest scenario with the tightest limit.
const CONTROL_RETAIN_KB = 64;

describe("Memory oracle calibration", () => {
  let result: Awaited<ReturnType<typeof runProbe>>;

  beforeAll(async () => {
    result = await runProbe("full-chain", { retainKb: CONTROL_RETAIN_KB });
  }, 120000);

  test(`${CONTROL_RETAIN_KB} KiB retained per operation reads at or above the chain RSS limit`, () => {
    // #given / #when — full-chain with a known retained allocation per operation
    // #then
    expect(retainedKbPerIter(result)).toBeGreaterThanOrEqual(MAX_CHAIN_LEAK_KB);
  });

  test("one retained buffer per operation reads at or above the JS object limit", () => {
    // #given / #when — full-chain with a known retained allocation per operation
    // #then
    expect(result.objectsPerIter).toBeGreaterThanOrEqual(MAX_OBJECTS_PER_ITER);
  });
});

// The consumer gates measure per event over batched operations (issue #25). Retention of 4 KiB
// per event must read red on the Effect consumer. At exactly the limit the control read 0.97 to
// 1.13, too close to the threshold to tell a weak gate from noise.
const CONSUMER_RETAIN_KB_PER_EVENT = 4;

describe("Memory oracle calibration: consumer per-event gate", () => {
  let result: Awaited<ReturnType<typeof runProbe>>;

  beforeAll(async () => {
    result = await runProbe("consumer-enqueue-effect", { retainKb: CONSUMER_RETAIN_KB_PER_EVENT * QUEUE_EVENTS_PER_OP });
  }, 120000);

  test(`${CONSUMER_RETAIN_KB_PER_EVENT} KiB retained per event reads at or above the runtime RSS limit`, () => {
    // #given / #when — the Effect consumer with a known retained allocation per event
    // #then
    expect(retainedKbPerIter(result) / QUEUE_EVENTS_PER_OP).toBeGreaterThanOrEqual(MAX_RUNTIME_LEAK_KB);
  });
});
