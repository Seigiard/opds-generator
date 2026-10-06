import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import * as v from "valibot";

/**
 * Each scenario runs in its own bun subprocess (test/helpers/leak-probe.ts) and
 * reports the least-squares RSS slope in KB/iter. In-process measurement is
 * unreliable: tests sharing a process contaminate each other's RSS trend
 * (observed +15-25 KB/iter on leak-free code mid-suite vs ~0 isolated), and a
 * two-point RSS delta flakes on single allocator spikes.
 */

const PROBE_PATH = join(import.meta.dir, "..", "helpers", "leak-probe.ts");

const MAX_LEAK_KB = 8;

// full-chain on a loaded GitHub runner drifts both estimators to ~1-2.4 KB/iter (see
// docs/known-flaky-tests.md §1): local runs show a strongly negative two-point
// (-7 KB/iter), proving no structural leak, so the CI readings are allocator/RSS
// noise, not retention. 3 keeps ≥25% margin over the observed CI ceiling while the
// historical real-leak signal (sharp .clone) was ~7 KB/iter. Re-tighten if chain
// metrics ever hold above 3 across quiet runs.
const MAX_CHAIN_LEAK_KB = 3;

const probeSchema = v.object({
  scenario: v.string(),
  slopeKbPerIter: v.number(),
  twoPointKbPerIter: v.number(),
  samples: v.number(),
  iterations: v.number(),
  rssEndMb: v.number(),
});

type ProbeResult = v.InferOutput<typeof probeSchema>;

async function runProbe(scenario: string): Promise<ProbeResult> {
  const proc = Bun.spawn(["bun", PROBE_PATH, scenario], { stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`leak-probe ${scenario} exited ${exitCode}: ${stderr}`);
  }

  const lastLine = stdout.trim().split("\n").at(-1) ?? "";
  const result = v.parse(probeSchema, JSON.parse(lastLine));
  console.log(
    `  ${scenario}: slope ${result.slopeKbPerIter.toFixed(2)} KB/iter over ${result.samples} samples ` +
      `(two-point: ${result.twoPointKbPerIter.toFixed(2)} KB/iter, rss end ${result.rssEndMb.toFixed(1)} MB)`,
  );

  return result;
}

describe("Memory leak detection (target: 0 KB/iter)", () => {
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

  // A real leak drives both estimators to the leak rate; allocator noise fools only
  // one (an endpoint spike inflates the two-point delta, a mid-run hump inflates the
  // slope). Requiring consensus keeps the tight threshold without flaking on noise.
  for (const { name, maxKbPerIter } of scenarios) {
    test(name, async () => {
      const result = await runProbe(name);
      const leakKbPerIter = Math.min(result.slopeKbPerIter, result.twoPointKbPerIter);
      expect(leakKbPerIter).toBeLessThan(maxKbPerIter);
    }, 120000);
  }
});
