import { describe, test, expect, beforeAll } from "bun:test";
import { MAX_HANDLER_LEAK_KB, MAX_OBJECTS_PER_ITER, retainedKbPerIter, runProbe } from "../helpers/run-leak-probe.ts";

// The handler chain (folder sync → book sync → folder and root feeds, PDF/CBZ/EPUB in
// turn) runs in the probe subprocess with the same filesystem adapter this test used
// in-process; sharing the test runner's process faked +10 KB/iter (issue #13).
// Issue #25: the effect variant runs the Effect 4 `bookSync` in the same chain.
describe.each(["handler-chain", "handler-chain-effect"])("Full handler memory leak (target: 0 KB/iter): %s", (scenario) => {
  let result: Awaited<ReturnType<typeof runProbe>>;

  beforeAll(async () => {
    result = await runProbe(scenario);
  }, 180000);

  test(`all formats interleaved retain less than ${MAX_HANDLER_LEAK_KB} KB of RSS per book`, () => {
    // #given / #when — the probe processed one book per operation
    // #then
    expect(retainedKbPerIter(result)).toBeLessThan(MAX_HANDLER_LEAK_KB);
  });

  test(`all formats interleaved retain less than ${MAX_OBJECTS_PER_ITER} JS objects per book`, () => {
    // #given / #when — the probe processed one book per operation
    // #then
    expect(result.objectsPerIter).toBeLessThan(MAX_OBJECTS_PER_ITER);
  });
});
