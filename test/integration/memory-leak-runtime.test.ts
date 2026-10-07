import { describe, expect, test, beforeAll } from "bun:test";
import { MAX_OBJECTS_PER_ITER, MAX_RUNTIME_LEAK_KB, QUEUE_EVENTS_PER_OP, retainedKbPerIter, runProbe } from "../helpers/run-leak-probe.ts";

// Measured in probe subprocesses. In the shared test process this suite read whatever
// the preceding test left behind: −6…−8 KB/iter after the in-process handler test,
// +0.6…+1.2 KB/iter once that test moved out (issue #13).
const scenarios = [
  { name: "queue-cycle", label: "SimpleQueue enqueue/take cycle", eventsPerOp: QUEUE_EVENTS_PER_OP },
  { name: "consumer-enqueue", label: "Consumer + enqueue cycle", eventsPerOp: QUEUE_EVENTS_PER_OP },
  // Issue #25: the Effect 4 processor prototype.
  { name: "consumer-enqueue-effect", label: "Effect consumer + enqueue cycle", eventsPerOp: QUEUE_EVENTS_PER_OP },
];

describe("Runtime memory leak isolation (post-Effect migration)", () => {
  for (const { name, label, eventsPerOp } of scenarios) {
    describe(label, () => {
      let result: Awaited<ReturnType<typeof runProbe>>;

      beforeAll(async () => {
        result = await runProbe(name);
      }, 60000);

      test(`retains less than ${MAX_RUNTIME_LEAK_KB} KB of RSS per event`, () => {
        // #given / #when — the probe ran the cycle in a pristine process
        // #then
        expect(retainedKbPerIter(result) / eventsPerOp).toBeLessThan(MAX_RUNTIME_LEAK_KB);
      });

      test(`retains less than ${MAX_OBJECTS_PER_ITER} JS objects per event`, () => {
        // #given / #when — the probe ran the cycle in a pristine process
        // #then
        expect(result.objectsPerIter / eventsPerOp).toBeLessThan(MAX_OBJECTS_PER_ITER);
      });
    });
  }
});
