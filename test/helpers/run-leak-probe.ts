import { join } from "node:path";
import * as v from "valibot";

// Native retention limits per measured operation, unchanged since issue #12.
export const MAX_LEAK_KB = 8;

// full-chain on a loaded GitHub runner drifts both estimators to ~1-2.4 KB/iter (see
// docs/known-flaky-tests.md §1). 3 keeps ≥25% margin over that ceiling while the
// historical real-leak signal (sharp .clone) was ~7 KB/iter.
export const MAX_CHAIN_LEAK_KB = 3;

export const MAX_HANDLER_LEAK_KB = 5;

export const MAX_RUNTIME_LEAK_KB = 1;

// A queue cycle allocates almost nothing, so RSS noise over 600 single-event operations
// reads ±2-3 KB per event. Batching events per probe operation divides that noise.
export const QUEUE_EVENTS_PER_OP = 100;

// Lifecycle scans and restarts are batched per probe operation for the same reason as queue cycles.
export const LIFECYCLE_CYCLES_PER_OP = 10;

// Retained JS objects per operation. Clean scenarios stay within ±0.1; a leak keeps at
// least one object (the leaked value) per operation.
export const MAX_OBJECTS_PER_ITER = 0.5;

const PROBE_PATH = join(import.meta.dir, "leak-probe.ts");

const probeSchema = v.object({
  scenario: v.string(),
  slopeKbPerIter: v.number(),
  twoPointKbPerIter: v.number(),
  objectsPerIter: v.number(),
  samples: v.number(),
  iterations: v.number(),
  rssEndMb: v.number(),
  series: v.array(v.number()),
});

type ProbeResult = v.InferOutput<typeof probeSchema>;

export async function runProbe(scenario: string, options: { retainKb?: number } = {}): Promise<ProbeResult> {
  const proc = Bun.spawn(["bun", PROBE_PATH, scenario], {
    stdout: "pipe",
    stderr: "pipe",
    // Lifecycle scenarios drive thousands of transitions; at info level their log lines would flood the probe's stdout.
    env: {
      ...process.env,
      LEAK_PROBE_RETAIN_KB: String(options.retainKb ?? 0),
      ...(scenario.startsWith("lifecycle-") && { LOG_LEVEL: "error" }),
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  if (exitCode !== 0) {
    throw new Error(`leak-probe ${scenario} exited ${exitCode}: ${stderr}`);
  }

  const lastLine = stdout.trim().split("\n").at(-1) ?? "";
  const result = v.parse(probeSchema, JSON.parse(lastLine));
  console.log(
    `  ${scenario}: slope ${result.slopeKbPerIter.toFixed(2)} KB/iter over ${result.samples} samples ` +
      `(two-point: ${result.twoPointKbPerIter.toFixed(2)} KB/iter, objects ${result.objectsPerIter.toFixed(3)}/iter, ` +
      `rss end ${result.rssEndMb.toFixed(1)} MB)`,
  );

  return result;
}

// A real leak drives both estimators to the leak rate; allocator noise fools only one
// (an endpoint spike inflates the two-point delta, a mid-run hump inflates the slope).
export function retainedKbPerIter(result: ProbeResult): number {
  return Math.min(result.slopeKbPerIter, result.twoPointKbPerIter);
}
