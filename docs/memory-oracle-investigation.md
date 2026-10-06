# Memory oracle investigation — 2026-10-06

## Status

The investigation is tracked in [issue #13](https://github.com/Seigiard/opds-generator/issues/13), a follow-up to command/resource ownership in issue #12.
No application leak or complete fix for the memory oracle was established.
The existing tests and their limits remain in place.

The experimental patch is preserved in `docs/memory-oracle-experiment.patch`.
It is research material, not an accepted replacement for the tests.
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
