import { describe, test, expect, beforeAll } from "bun:test";
import { MAX_CHAIN_LEAK_KB, MAX_OBJECTS_PER_ITER, retainedKbPerIter, runProbe } from "../helpers/run-leak-probe.ts";

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
