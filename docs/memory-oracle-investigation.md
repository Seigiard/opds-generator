# Memory oracle investigation — 2026-10-06

## Status

The investigation is tracked in [issue #13](https://github.com/Seigiard/opds-generator/issues/13), a follow-up to command/resource ownership in issue #12.
No application leak was established. The second round (below, "Oracle redesign")
changed the probe schedule, added an exact JS-object gate and a calibration test.
The RSS limits (8, 3 for full-chain, 5 for the handler chain) are unchanged.
The handler-chain RSS gate remains weak at its limit; see "Known limits".

The experimental patch is preserved in `docs/memory-oracle-experiment.patch`.
It is research material from the first round, superseded by the redesign.
Apply it in a disposable checkout before using the diagnostic launcher below.
The patch is based on the normalized, 140-column test files.

## Environment and workload

- Application baseline: `b718554a8b4d55e50161ff892e94fc44ad9d8bf6`.
- Scoped command implementation: `f8d76f1f0f318afb6f73e568c1d647fbab1bffeb`.
- Main runtime: Bun 1.4.2, revision `744846f84`.
- Runtime comparison: Bun 1.3.14, revision `0d9b296a`.
- Effect 4.0.1; sharp 0.34.5; libvips 8.17.3; mimalloc 3.5.0.
- Original handler test: 100 warmup and 100 measured operations, custom filesystem
  adapter, two-point RSS delta, limit below 5 KB/iteration.
- Experimental handler probe: 150 warmup and 300 measured operations, production
  filesystem adapter, RSS floor every 10 operations, slope/two-point consensus.
- Long diagnostic runs: 150 warmup and 1200 measured operations. Each processed
  450 PDF, 450 CBZ and 450 EPUB books through folder sync, book sync, folder feed
  generation and root feed generation, then removed that iteration's folders.

The original test and experimental probe differ in workload and measurement.
Their results are not a one-factor filesystem comparison.
The long driver also retains diagnostic snapshots; total object count includes
that instrumentation and is not an application-retention measurement.

## Observations

| Experiment                                  | Slope KB/iter | Two-point KB/iter | Outcome                        |
| ------------------------------------------- | ------------: | ----------------: | ------------------------------ |
| Original shared-process handler test        |             — |             10.12 | Failed below-5 limit           |
| Original handler test alone                 |             — |            -17.48 | Passed                         |
| Exact original test, Bun 1.4.2              |             — |              4.64 | Passed, narrow margin          |
| Exact original test, Bun 1.3.14             |             — |            -23.36 | Passed                         |
| Experimental probe, scoped commands         |          9.86 |             10.68 | Failed below-5 limit           |
| Same probe with baseline application source |         10.79 |             11.21 | Failed below-5 limit           |
| Current probe, default allocator            |          6.53 |             10.55 | Failed below-5 limit           |
| Current probe, `MIMALLOC_PURGE_DELAY=0`     |         -4.93 |             -6.21 | Passed                         |
| 64 KiB/iter retention, purge=0              |         64.46 |             54.12 | Correctly failed below-5 limit |
| All memory suites, purge=0: `full-chain`    |          5.83 |              7.36 | Failed below-3 limit           |

The all-memory run with purge=0 had 11 passes and one failure. Its handler-chain
case passed at -9.30/-32.76 KB/iteration. Purge=0 is therefore not a complete fix.
Replacing the probe's existence check with stat still failed at 8.57 KB/iteration.
Also replacing atomic writes with direct writes still failed at 5.97 KB/iteration.
Those temporary filesystem overrides were removed.

### Long-run RSS

Values are MB. These are samples from one run per condition, not repeatability claims.

| Measured iteration | Bun 1.4.2 RSS | Bun 1.4.2 heap | Bun 1.3.14 RSS | Bun 1.4.2, purge=0 RSS |
| -----------------: | ------------: | -------------: | -------------: | ---------------------: |
|                  0 |       167.145 |         15.535 |        176.363 |                141.164 |
|                300 |       166.758 |         15.577 |        177.063 |                143.129 |
|                600 |       145.070 |         12.870 |        176.359 |                143.875 |
|                900 |       146.922 |         12.949 |        177.016 |                140.801 |
|               1200 |       148.883 |         12.881 |        162.922 |                139.867 |

The Bun 1.4.2 run contained a red 600–900 window: slope 5.41 and two-point 6.32.
Across all 1200 operations its RSS fell by 18.26 MB, with estimates -26.98/-15.58.
A positive 300-operation window did not establish sustained linear retention.
This also does not exclude a smaller native leak masked by other deallocation.

Protected object count stayed at 511. Subprocess count stayed at 1. ArrayBuffer
count stayed around 5–6 and Promise count around 897–902. Sharp queue/process
counters were 0/0; cache items stayed at 100/100, current cache memory at 0 MB,
and cache file count at 0. Growth of the reported sharp cache was not established.
Some mimalloc counters were inconsistent, including negative counts and committed
bytes above reserved bytes; those counters were excluded from retention conclusions.

### Idle release after synchronous GC

| Condition           | RSS at workload end | After 100 ms idle | After another 1000 ms idle |
| ------------------- | ------------------: | ----------------: | -------------------------: |
| Bun 1.4.2, default  |             148.883 |           137.266 |                    136.199 |
| Bun 1.3.14, default |             162.922 |           162.512 |                    158.785 |
| Bun 1.4.2, purge=0  |             139.867 |           129.801 |                    127.910 |

Bun 1.4.2 default released 11.62 MB during the first 100 ms without new book work.
JS heap fell by only about 0.15 MB. Several synchronous GC calls do not prove that
native finalization and allocator page return have completed.
The contribution of finalization, event-loop scheduling and page return remains unresolved.

## Reproduction

Run in Docker. The host CI pin at `.github/workflows/docker.yml` does not pin the
memory-test runtime: `Dockerfile` currently uses floating `oven/bun:1-alpine`.
The tested `bunx --package bun@1.3.14 bun ...` invocation selected Bun 1.3.14 for
both parent and its PATH-resolved `bun` child; a mismatch was not reproduced.

```sh
docker compose -f docker-compose.test.yml run --rm test \
  bun test test/integration/memory-leak-handler.test.ts

docker compose -f docker-compose.test.yml run --rm \
  -e MIMALLOC_PURGE_DELAY=0 test \
  bun test test/integration/memory-leak-handler.test.ts

docker compose -f docker-compose.test.yml run --rm \
  -e MIMALLOC_PURGE_DELAY=0 test \
  bun test test/integration/memory-leak.test.ts \
  test/integration/memory-leak-handler.test.ts \
  test/integration/memory-leak-runtime.test.ts
```

For the extended runs, apply the experimental patch in a disposable checkout.
Save the launcher below as a temporary file and mount it at `/diagnostic.ts`:

```sh
docker compose -f docker-compose.test.yml run --rm \
  -v "$DIAGNOSTIC:/diagnostic.ts:ro" -e DIAG_IDLE=1 test bun /diagnostic.ts

# Change only the runtime for the runtime comparison.
docker compose -f docker-compose.test.yml run --rm \
  -v "$DIAGNOSTIC:/diagnostic.ts:ro" -e DIAG_IDLE=1 test \
  bunx --package bun@1.3.14 bun /diagnostic.ts

# Change only the startup allocator setting for the allocator comparison.
docker compose -f docker-compose.test.yml run --rm \
  -v "$DIAGNOSTIC:/diagnostic.ts:ro" -e DIAG_IDLE=1 \
  -e MIMALLOC_PURGE_DELAY=0 test bun /diagnostic.ts
```

### Diagnostic launcher

This preserves the experiment used for the long-run observations. It generates
only a container-local script and runs the actual application handlers.

```ts
const source = await Bun.file('/app/test/helpers/leak-probe.ts').text();
const prefix = source.slice(0, source.indexOf('const scenario = process.argv[2];'))
  .replaceAll('"../../src/', '"/app/src/');
const originalFs = `{
  mkdir: async (path, options) => { await mkdir(path, options); },
  rm: (path, options) => rm(path, options),
  readdir: async (path) => { const fs = await import('node:fs/promises'); return fs.readdir(path); },
  stat: async (path) => { const s = await stat(path); return { isDirectory: () => s.isDirectory(), size: s.size }; },
  exists: async (path) => { try { await stat(path); return true; } catch { return false; } },
  writeFile: async (path, content) => { await Bun.write(path, content); },
  atomicWrite: async (path, content) => { await Bun.write(path, content); },
  symlink: async (target, path) => { const { unlink, symlink } = await import('node:fs/promises'); try { await unlink(path); } catch {} await symlink(target, path); },
  unlink: async (path) => { const { unlink } = await import('node:fs/promises'); await unlink(path); },
}`;
const mode = process.env.DIAG_FS ?? 'production';
const selected = mode === 'original' ? prefix.replace('fs: context.fs,', `fs: ${originalFs},`) : prefix;
const suffix = `
import { heapStats } from 'bun:jsc';
import sharp from '/app/node_modules/sharp/lib/index.js';
const warmup = Number(process.env.DIAG_WARMUP ?? 150);
const iterations = Number(process.env.DIAG_ITERATIONS ?? 1200);
const original = process.env.DIAG_SCHEDULE === 'original';
const tmpDir = '/tmp/opds-diagnostic-' + process.pid;
const counts = { pdf: 0, cbz: 0, epub: 0 };
const op = await buildScenario('handler-chain', tmpDir);
const series = [];
function snapshot(iter, phase) {
  const rssMb = original ? (Bun.gc(true), Bun.gc(true), Bun.gc(true), getRssMb()) : sampleRssFloorMb();
  const mem = process.memoryUsage();
  const heap = heapStats();
  const mi = heap.mimalloc;
  return { phase, iter, rssMb, heapUsed: mem.heapUsed, external: mem.external,
    heapSize: heap.heapSize, heapCapacity: heap.heapCapacity, extraMemorySize: heap.extraMemorySize,
    objectCount: heap.objectCount, protectedObjectCount: heap.protectedObjectCount,
    types: Object.fromEntries(['Promise','Object','Function','string','ArrayBuffer','Uint8Array','Subprocess','BunFile','NapiExternal','NapiHandleScopeImpl'].map(k => [k, heap.objectTypeCounts[k] ?? 0])),
    protectedTypes: heap.protectedObjectTypeCounts,
    mi: mi ? { pages: mi.pages.current, committed: mi.committed.current, reserved: mi.reserved.current,
      purged: mi.purged, purgeCalls: mi.purge_calls, threads: mi.threads.current, heaps: mi.heaps.current,
      abandoned: mi.pages_abandoned.current, huge: mi.malloc_huge.current } : null,
    cache: sharp.cache(), counters: sharp.counters(), counts: { ...counts }, elapsedMs: Date.now() - started };
}
function bump(i) { counts[['pdf','cbz','epub'][i % 3]]++; }
const started = Date.now();
console.log(JSON.stringify({ event: 'start', bun: Bun.version, exec: process.execPath, warmup, iterations,
  fs: process.env.DIAG_FS ?? 'production', schedule: original ? 'original' : 'probe',
  mimallocEnv: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('MIMALLOC'))),
  sharp: sharp.versions }));
try {
  for (let i = 0; i < warmup; i++) {
    const id = original ? i : i + 100000;
    await op(id); bump(id);
    if (i % (original ? 5 : 10) === 0) Bun.gc(true);
    if ((i + 1) % 50 === 0) console.log(JSON.stringify({ event: 'warmup', iter: i + 1, elapsedMs: Date.now() - started }));
  }
  const initial = snapshot(0, 'measure'); series.push(initial); console.log(JSON.stringify(initial));
  for (let i = 0; i < iterations; i++) {
    await op(i); bump(i); Bun.gc(true);
    if ((i + 1) % 10 === 0) {
      const s = snapshot(i + 1, 'measure'); series.push(s);
      if ((i + 1) % 50 === 0) console.log(JSON.stringify(s));
    }
  }
  const windows = [];
  for (let start = 0; start < iterations; start += 300) {
    const samples = series.filter(s => s.iter >= start && s.iter <= Math.min(start + 300, iterations));
    const first = samples[0], last = samples.at(-1);
    windows.push({ start, end: last.iter, slope: fitSlopeKbPerIter(samples), twoPoint: (last.rssMb - first.rssMb) * 1024 / (last.iter - first.iter) });
  }
  const first = series[0], last = series.at(-1);
  console.log(JSON.stringify({ event: 'result', bun: Bun.version, windows,
    slope: fitSlopeKbPerIter(series), twoPoint: (last.rssMb - first.rssMb) * 1024 / iterations, series, counts }));
  if (process.env.DIAG_IDLE === '1') {
    for (const delay of [100, 1000, 5000]) { await Bun.sleep(delay); console.log(JSON.stringify(snapshot(iterations, 'idle-' + delay))); }
  }
} finally { await rm(tmpDir, { recursive: true, force: true }); }
`;
const path = '/tmp/opds-memory-diagnostic-generated.ts';
await Bun.write(path, selected + suffix);
const child = Bun.spawn([process.execPath, path], { stdout: 'inherit', stderr: 'inherit', env: process.env });
process.exit(await child.exited);
```

## Remaining work

- Separate the original 100/100/custom-fs contract from the production-adapter probe.
- Define an observable native-cleanup/idle boundary before RSS sampling.
- Fix the actual Docker runtime for comparable measurements.
- Calibrate near 5 KiB/iteration as well as the successful 64 KiB control.
- Validate the entire memory gate, including the unchanged full-chain limit of 3.
- Distinguish retained live objects from bounded allocator/JIT/cache growth.
- Record unresolved evidence instead of raising limits or calling a short green run proof of no leak.

## Oracle redesign — second round

Docker test image, Bun 1.4.2. Diagnosis details are in the issue #13 comment of 2026-10-06.

### Causes found

1. **Regime change at iter 0.** Warmup ran a full GC every 10 operations, measurement
   after every operation. The first floor sample sat 2–3 MB above the next one. Two-point
   read negative (−0.2 … −7.2) and slope positive (+3.2 … +5.2) on `full-chain`.
2. **Bounded ramp.** In a matched regime, RSS rises 2–4 MB over the first 400–600
   operations, then plateaus; multi-MB releases follow. A 300-operation window at limit 3
   (≈ 0.9 MB) read the ramp as retention. Subprocess commands produce most of it; JSC
   object counts show no growth.
3. **Format phase.** The handler chain rotates PDF, CBZ, EPUB. Sampling every 10
   operations landed after a different format each time: a ~6 MB period-3 sawtooth.
4. **Masking.** Retained blocks land in already-resident free pages. After ~1000
   operations, 5 KiB/operation of retention no longer showed in RSS with any estimator
   (slope, two-point, envelope, block minima).

Not causes (ramp unchanged): `sharp.concurrency(1)`, `sharp.cache(false)`,
`MIMALLOC_PURGE_DELAY=0`. Idle before the first sample makes the baseline a trough.

No exact native counter is available: Bun's mimalloc `malloc_*` statistics read 0,
`committed` grows by hundreds of KB per operation, and an LD_PRELOAD malloc/free counter
misses frees that Bun performs internally.

### Changes

- `test/helpers/leak-probe.ts`: full GC after every warmup operation; warmup 300 and
  600 measured operations; a sample every 12 operations (a multiple of the format
  rotation); the handler chain runs in the probe with the original filesystem adapter.
- Exact JS-object gate: the sum of per-type growth in `heapStats().objectTypeCounts`
  per operation, limit 0.5. Clean scenarios read 0.002–0.085. Summing only growth keeps
  JSC code discards (thousands of CodeBlock/Executable/string cells at once) from
  cancelling growth.
- `LEAK_PROBE_RETAIN_KB` keeps a new allocation of that size alive per measured operation.
  A single preallocated pool is not a valid control: it takes resident pages up front.
- `test/integration/memory-oracle-calibration.test.ts`: `full-chain` with 64 KiB retained
  per operation must read at or above the chain RSS limit and the object limit.
- The runtime suite (`SimpleQueue`, consumer) also moved into the probe. In the shared
  test process it had read −6…−8 KB/iter only because it ran after the heavy in-process
  handler test; alone it read +0.6…+1.2 against its limit of 1. A queue operation now
  runs 100 enqueue/take cycles (noise ±0.006 KB per event). The consumer stays at one
  event per operation: the production consumer runs a full GC per event.

### Calibration

| Condition                                       |                 RSS red | Object reading |
| ----------------------------------------------- | ----------------------: | -------------: |
| `full-chain`, clean (limit 3)                   |                    1/11 |          0.003 |
| `full-chain`, 5 KiB retained                    |                     4/5 |          1.003 |
| `full-chain`, 64 KiB retained                   | 3/3 (61.8–63.6 KB/iter) |          1.003 |
| `handler-chain`, clean, phase-aligned (limit 5) |                    0/13 |    0.002–0.003 |
| `handler-chain`, 8 KiB retained                 |                     1/5 |    1.002–1.003 |

All memory suites: 3 of 3 runs passed, 24/24 tests each. Full `bun run test` after the
runtime change: 3 of 3 runs passed, 482/482. The `full-chain` clean red (5.11/5.39) came
from the 10-operation sampling before phase alignment. One earlier full run on this branch
had a handler-chain RSS red whose value was not captured.

### Known limits

- The handler-chain RSS gate detects 8 KiB/operation of retention in about 1 of 5 runs.
  Its JS-object gate is exact. Native retention below ~10 KiB per book in the handler
  chain can pass CI; a long run (≥ 3000 operations, plateau check) is the tool for it.
- Bounded growth is acceptable: a plateau after the ramp is not a leak.

## Consumer gates batch 100 events — issue #25

- `consumer-enqueue` and `consumer-enqueue-effect` run 100 events per measured operation and divide by 100, as `queue-cycle` does. The limit (1 KB RSS, 0.5 objects per event) is unchanged.
- At one event per operation the gate could not resolve its limit: clean plain runs read up to 1.09 KB per event, and 1 KiB retained per event read as low as 0.58 (plain) and 0.3 (Effect). The Effect consumer also read 2.4 to 2.7 on clean code during its JIT warmup.
- Batched, clean runs read at most 0.055 KB per event and 1 KiB retained per event reads 0.97 to 1.13. `memory-oracle-calibration.test.ts` checks the red side on `consumer-enqueue-effect` with 4 KiB retained per event.
- The batched gates measure retention per event. Retention once per drain (busy/empty edge, idle take) is spread over 100 events; `lifecycle-scan` covers it for the plain processor.
- Probe children inherit `LOG_LEVEL=warn` from `docker-compose.test.yml`, so the consumer's info logs are off in every gate run.
- Details: `docs/effect-processing-prototype.md`, "The consumer gate".

## Effect per-drain lifecycle gate — issue #33

- `lifecycle-scan-effect` runs the existing lifecycle scan workload with `createEffectCatalogueProcessor`. It measures one folder refresh arriving at an idle Effect processor, batched by `LIFECYCLE_CYCLES_PER_OP` like the plain `lifecycle-scan` gate.
- The gate uses the unchanged runtime limits: 1 KB RSS per drain and 0.5 JS objects per drain.
- `memory-oracle-calibration.test.ts` checks the red side with `LEAK_PROBE_RETAIN_KB` at 4 KiB per Effect drain, multiplied by `LIFECYCLE_CYCLES_PER_OP` because the probe retains once per measured operation.
