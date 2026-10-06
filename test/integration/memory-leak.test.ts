import { describe, test, expect, beforeAll } from "bun:test";
import { MAX_CHAIN_LEAK_KB, MAX_LEAK_KB, MAX_OBJECTS_PER_ITER, retainedKbPerIter, runProbe } from "../helpers/run-leak-probe.ts";

/**
 * Each scenario runs in its own bun subprocess (test/helpers/leak-probe.ts). In-process
 * measurement is unreliable: tests sharing a process contaminate each other's RSS trend
 * (observed +15-25 KB/iter on leak-free code mid-suite vs ~0 isolated). The probe's
 * calibration is pinned by memory-oracle-calibration.test.ts.
 */

const scenarios: Array<{ name: string; maxKbPerIter: number }> = [
  { name: "bun-file-arraybuffer", maxKbPerIter: MAX_LEAK_KB },
  { name: "fs-readfile", maxKbPerIter: MAX_LEAK_KB },
  { name: "spawn-echo", maxKbPerIter: MAX_LEAK_KB },
  { name: "spawn-zipinfo", maxKbPerIter: MAX_LEAK_KB },
  { name: "list-entries", maxKbPerIter: MAX_LEAK_KB },
  { name: "read-entry", maxKbPerIter: MAX_LEAK_KB },
  { name: "save-buffer-as-image", maxKbPerIter: MAX_LEAK_KB },
  { name: "save-cover-and-thumbnail", maxKbPerIter: MAX_LEAK_KB },
  { name: "full-chain", maxKbPerIter: MAX_CHAIN_LEAK_KB },
];

describe("Memory leak detection (target: 0 KB/iter)", () => {
  for (const { name, maxKbPerIter } of scenarios) {
    describe(name, () => {
      let result: Awaited<ReturnType<typeof runProbe>>;

      beforeAll(async () => {
        result = await runProbe(name);
      }, 120000);

      test(`retains less than ${maxKbPerIter} KB of RSS per operation`, () => {
        // #given / #when — the probe ran the scenario in a pristine process
        // #then
        expect(retainedKbPerIter(result)).toBeLessThan(maxKbPerIter);
      });

      test(`retains less than ${MAX_OBJECTS_PER_ITER} JS objects per operation`, () => {
        // #given / #when — the probe ran the scenario in a pristine process
        // #then
        expect(result.objectsPerIter).toBeLessThan(MAX_OBJECTS_PER_ITER);
      });
    });
  }
});
