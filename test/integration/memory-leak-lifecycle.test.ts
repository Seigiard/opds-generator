import { describe, expect, test, beforeAll } from "bun:test";
import {
  LIFECYCLE_CYCLES_PER_OP,
  MAX_OBJECTS_PER_ITER,
  MAX_RUNTIME_LEAK_KB,
  retainedKbPerIter,
  runProbe,
} from "../helpers/run-leak-probe.ts";

// Each cycle is one scan (or one start-scan-stop). The limits are the runtime limits, unchanged.
const scenarios = [
  { name: "lifecycle-scan", label: "Lifecycle repeated scans" },
  { name: "lifecycle-scan-effect", label: "Effect lifecycle repeated scans" },
  { name: "lifecycle-restart", label: "Lifecycle start/scan/stop" },
];

describe("Lifecycle memory leak", () => {
  for (const { name, label } of scenarios) {
    describe(label, () => {
      let result: Awaited<ReturnType<typeof runProbe>>;

      beforeAll(async () => {
        result = await runProbe(name);
      }, 180000);

      test(`retains less than ${MAX_RUNTIME_LEAK_KB} KB of RSS per cycle`, () => {
        // #given / #when — the probe ran the cycles in a pristine process
        // #then
        expect(retainedKbPerIter(result) / LIFECYCLE_CYCLES_PER_OP).toBeLessThan(MAX_RUNTIME_LEAK_KB);
      });

      test(`retains less than ${MAX_OBJECTS_PER_ITER} JS objects per cycle`, () => {
        // #given / #when — the probe ran the cycles in a pristine process
        // #then
        expect(result.objectsPerIter / LIFECYCLE_CYCLES_PER_OP).toBeLessThan(MAX_OBJECTS_PER_ITER);
      });
    });
  }
});
