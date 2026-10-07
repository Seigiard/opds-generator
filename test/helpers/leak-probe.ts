/**
 * Memory-leak probe: runs one scenario in a pristine process and prints a JSON
 * result line. Spawned per-scenario by the memory-leak tests — tests sharing a
 * process contaminate each other's RSS trend (allocator arenas decommitted by one
 * test recommit during the next, faking +15-25 KB/iter growth on leak-free code),
 * so each measurement gets its own process.
 *
 * Warmup and measurement run in the same GC regime (full GC after every operation).
 * With a sparser warmup GC the first floor sample sits 2-3 MB above the next one,
 * which biased the two-point estimate down and the slope up (issue #13).
 *
 * LEAK_PROBE_RETAIN_KB keeps that many KiB live per measured operation. It is the
 * calibration control: the gate must go red with it at its limit and green without it.
 */
import { spawnWithTimeoutText } from "../../src/utils/process.ts";
import { saveBufferAsImage, saveCoverAndThumbnail } from "../../src/utils/image.ts";
import { listEntries, readEntry } from "../../src/utils/archive.ts";
import { bookSync } from "../../src/processing/handlers/book-sync.ts";
import { folderSync } from "../../src/processing/handlers/folder-sync.ts";
import { folderMetaSync } from "../../src/processing/handlers/folder-meta-sync.ts";
import { createCatalogueProcessor, type CatalogueProcessor, type Handlers } from "../../src/processing/catalogue-processor.ts";
import { createEffectCatalogueProcessor } from "../../src/processing/catalogue-processor-effect.ts";
import { fromPromiseHandler, runAsPromiseHandler } from "../../src/processing/effect-handler.ts";
import { bookSyncEffect } from "../../src/processing/handlers/book-sync-effect.ts";
import { createLifecycle, type CatalogueScanner } from "../../src/lifecycle/lifecycle.ts";
import { SimpleQueue } from "../../src/queue.ts";
import type { AppContext, HandlerDeps } from "../../src/context.ts";
import type { EventType } from "../../src/processing/types.ts";
import { ok } from "neverthrow";
import { LIFECYCLE_CYCLES_PER_OP, QUEUE_EVENTS_PER_OP } from "./run-leak-probe.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { heapStats } from "bun:jsc";
import { mkdir, readFile, readdir, rm, stat, symlink, unlink } from "node:fs/promises";

const FIXTURES_DIR = "/app/files/test";

const EPUB_PATH = join(FIXTURES_DIR, "Test Book - Test Author.epub");

const CBZ_PATH = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");

const HANDLER_BOOKS = ["Test Book - Test Author.pdf", "bobby_make_believe_sample.cbz", "Test Book - Test Author.epub"];

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x01, 0x03, 0x00, 0x00, 0x00, 0x25, 0xdb, 0x56, 0xca, 0x00, 0x00, 0x00, 0x06, 0x50, 0x4c, 0x54, 0x45, 0xff, 0x00, 0x00, 0xff, 0xff,
  0xff, 0x41, 0x1d, 0x34, 0x11, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
  0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

// RSS rises 2-4 MB over the first 400-600 operations of a leak-free workload, then
// plateaus; later, multi-MB releases follow. Calibration (issue #13) found warmup 300 +
// 600 measured operations the only setting with no red on clean runs and a red on
// retained memory at the chain limit; longer windows lose sensitivity because retained
// blocks land in already-resident free pages.
const WARMUP_ITERATIONS = Number(process.env.LEAK_PROBE_WARMUP ?? 300);

const ITERATIONS = Number(process.env.LEAK_PROBE_ITERATIONS ?? 600);

// A multiple of the handler chain's three-format rotation: sampling every 10 operations
// landed after a different format each time and added a ~6 MB period-3 sawtooth.
const SAMPLE_EVERY = 12;

const RETAIN_KB = Number(process.env.LEAK_PROBE_RETAIN_KB ?? 0);

type Op = (i: number) => Promise<void>;

function getRssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function sampleRssFloorMb(): number {
  Bun.gc(true);
  Bun.gc(true);
  Bun.gc(true);
  let min = getRssMb();

  for (let i = 0; i < 2; i++) {
    Bun.gc(true);
    min = Math.min(min, getRssMb());
  }

  return min;
}

// A two-point RSS delta is dominated by allocator jitter (mimalloc arenas, sharp/libvips
// buffers) — one spike at the final sample fakes a leak. The least-squares slope across
// many samples measures the trend, which is what "0 KB/iter" actually asserts.
function fitSlopeKbPerIter(rssMb: Float64Array): number {
  const n = rssMb.length;
  const meanX = ((n - 1) * SAMPLE_EVERY) / 2;
  const meanY = rssMb.reduce((sum, y) => sum + y, 0) / n;
  let covXY = 0;
  let varX = 0;

  for (let k = 0; k < n; k++) {
    const dx = k * SAMPLE_EVERY - meanX;
    covXY += dx * (rssMb[k]! - meanY);
    varX += dx ** 2;
  }

  return (covXY / varX) * 1024;
}

// JSC periodically discards compiled code: thousands of CodeBlock, Executable and
// source-string cells vanish at once mid-run. Summing only per-type growth keeps such
// a drop from cancelling growth in the types a retained object would add.
function sumTypeGrowth(before: Record<string, number>, after: Record<string, number>): number {
  let growth = 0;

  for (const [type, count] of Object.entries(after)) {
    growth += Math.max(0, count - (before[type] ?? 0));
  }

  return growth;
}

async function buildScenario(name: string, tmpDir: string): Promise<Op> {
  switch (name) {
    case "bun-file-arraybuffer":
      return async () => {
        await Bun.file(EPUB_PATH).arrayBuffer();
      };

    case "fs-readfile":
      return async () => {
        await readFile(EPUB_PATH);
      };

    case "spawn-echo":
      return () => spawnWithTimeoutText({ command: ["echo", "hello"] }).then(() => {});
    case "spawn-zipinfo":
      return () => spawnWithTimeoutText({ command: ["zipinfo", "-1", EPUB_PATH] }).then(() => {});
    case "list-entries":
      return () => listEntries(CBZ_PATH).then(() => {});
    case "read-entry": {
      const image = await findCbzImage();

      return () => readEntry(CBZ_PATH, image).then(() => {});
    }

    case "save-buffer-as-image":
      return async (i) => {
        await saveBufferAsImage(VALID_PNG, join(tmpDir, `img-${i}.jpg`), 100);
      };

    case "save-cover-and-thumbnail":
      return async (i) => {
        await saveCoverAndThumbnail(VALID_PNG, join(tmpDir, `cover-${i}.jpg`), 600, join(tmpDir, `thumb-${i}.jpg`), 200);
      };

    case "full-chain": {
      const image = await findCbzImage();

      return async (i) => {
        const buf = await readEntry(CBZ_PATH, image);

        if (buf) {
          await saveCoverAndThumbnail(buf, join(tmpDir, `cover-${i}.jpg`), 600, join(tmpDir, `thumb-${i}.jpg`), 200);
        }
      };
    }

    case "handler-chain":
      return buildHandlerChain(tmpDir, "plain");
    case "handler-chain-effect":
      return buildHandlerChain(tmpDir, "effect");

    case "queue-cycle": {
      const queue = new SimpleQueue<EventType>();

      return async () => {
        for (let e = 0; e < QUEUE_EVENTS_PER_OP; e++) {
          queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/test" });
          await queue.take();
        }
      };
    }

    case "consumer-enqueue":
      return buildConsumerCycle("plain");
    case "consumer-enqueue-effect":
      return buildConsumerCycle("effect");

    case "lifecycle-scan":
      return buildLifecycleScans();
    case "lifecycle-restart":
      return buildLifecycleRestarts();

    default:
      throw new Error(`Unknown scenario: ${name}`);
  }
}

// One book per operation through the event handlers (PDF, CBZ, EPUB in turn), with the
// filesystem adapter the original in-process handler test used. The effect variant runs the
// Effect 4 `bookSync` (issue #25); the folder handlers stay plain in both.
async function buildHandlerChain(tmpDir: string, variant: "plain" | "effect"): Promise<Op> {
  const filesDir = join(tmpDir, "files");
  const dataDir = join(tmpDir, "data");
  await mkdir(filesDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const deps: HandlerDeps = {
    config: { filesPath: filesDir, dataPath: dataDir, port: 3000, reconcileInterval: 1800 },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fs: {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      rm: (path, options) => rm(path, options),
      readdir: (path) => readdir(path),
      stat: async (path) => {
        const s = await stat(path);

        return { isDirectory: () => s.isDirectory(), size: s.size };
      },
      exists: async (path) => {
        try {
          await stat(path);

          return true;
        } catch {
          return false;
        }
      },
      writeFile: async (path, content) => {
        await Bun.write(path, content);
      },
      atomicWrite: async (path, content) => {
        await Bun.write(path, content);
      },
      symlink: async (target, path) => {
        try {
          await unlink(path);
        } catch {}

        await symlink(target, path);
      },
      unlink: (path) => unlink(path),
    },
  };

  return async (i) => {
    const folderName = `book-${i}`;
    const folderPath = join(filesDir, folderName);
    const folderDataPath = join(dataDir, folderName);
    const bookFile = HANDLER_BOOKS[i % HANDLER_BOOKS.length]!;
    await mkdir(folderPath, { recursive: true });

    try {
      await Bun.write(join(folderPath, bookFile), await Bun.file(join(FIXTURES_DIR, bookFile)).arrayBuffer());
      (await folderSync({ _tag: "FolderCreated", parent: filesDir, name: folderName }, deps))._unsafeUnwrap();
      const book: EventType = { _tag: "BookCreated", parent: folderPath, name: bookFile };
      (variant === "plain" ? await bookSync(book, deps) : await runAsPromiseHandler(bookSyncEffect, book, deps))._unsafeUnwrap();
      (await folderMetaSync({ _tag: "FolderMetaSyncRequested", path: folderDataPath }, deps))._unsafeUnwrap();
      (await folderMetaSync({ _tag: "FolderMetaSyncRequested", path: dataDir }, deps))._unsafeUnwrap();
      // A handler that silently skips the book must not pass the gate by avoiding the workload.
      await stat(join(folderDataPath, bookFile, "entry.xml"));
    } finally {
      await rm(folderDataPath, { recursive: true, force: true });
      await rm(folderPath, { recursive: true, force: true });
    }
  };
}

// QUEUE_EVENTS_PER_OP events per operation through the running consumer loop; the operation
// completes when the registered handler has processed the last one. With one event per
// operation the gate could not resolve 1 KB per event: clean runs read up to 1.1 and 1 KiB
// retained per event as low as 0.3. Batching also runs the Effect consumer past its JIT
// warmup, which read 1.6 to 2.7 KB per event in the first 600 single events (issue #25).
// Distinct paths, so the processor does not coalesce the batch into one refresh.
function buildConsumerCycle(variant: "plain" | "effect"): Op {
  let remaining = 0;
  let markProcessed = () => {};

  const { config, logger, fs } = buildContext();

  const handlers: Handlers = {
    FolderMetaSyncRequested: async () => {
      if (--remaining === 0) markProcessed();

      return ok<readonly EventType[]>([]);
    },
  };

  const processor: CatalogueProcessor =
    variant === "plain"
      ? createCatalogueProcessor({ deps: { config, logger, fs }, handlers })
      : createEffectCatalogueProcessor({
          deps: { config, logger, fs },
          handlers: { FolderMetaSyncRequested: fromPromiseHandler(handlers.FolderMetaSyncRequested!) },
        });

  processor.start(new AbortController().signal).catch(() => {
    console.error("leak-probe: consumer loop failed");
    process.exit(1);
  });

  return () =>
    new Promise<void>((resolve) => {
      markProcessed = resolve;
      remaining = QUEUE_EVENTS_PER_OP;

      for (let e = 0; e < QUEUE_EVENTS_PER_OP; e++) processor.submit({ _tag: "FolderMetaSyncRequested", path: `/test/${e}` });
    });
}

function buildLifecycle() {
  const { config, logger, fs } = buildContext();

  const processor = createCatalogueProcessor({
    deps: { config, logger, fs },
    handlers: { FolderMetaSyncRequested: async () => ok<readonly EventType[]>([]) },
  });

  const scanner: CatalogueScanner = { scan: async () => [{ _tag: "FolderMetaSyncRequested", path: "/test" }] };

  return createLifecycle({
    scanner,
    processor,
    clock: { sleep: () => new Promise<void>(() => {}) },
    reconcileIntervalSeconds: 0,
  });
}

async function untilSettled(lifecycle: ReturnType<typeof buildLifecycle>): Promise<void> {
  while (lifecycle.status().state !== "settled") await new Promise((resolve) => setImmediate(resolve));
}

// One lifecycle for the whole run; each cycle is a resync scan whose one folder refresh runs through the consumer.
function buildLifecycleScans(): Op {
  const lifecycle = buildLifecycle();
  lifecycle.start();

  return async () => {
    for (let cycle = 0; cycle < LIFECYCLE_CYCLES_PER_OP; cycle++) {
      await untilSettled(lifecycle);
      lifecycle.requestScan({ kind: "resync", force: false });
      await untilSettled(lifecycle);
    }
  };
}

// A fresh lifecycle per cycle: start, one scan, stop. Catches anything that survives its owner.
function buildLifecycleRestarts(): Op {
  return async () => {
    for (let cycle = 0; cycle < LIFECYCLE_CYCLES_PER_OP; cycle++) {
      const lifecycle = buildLifecycle();
      lifecycle.start();
      await untilSettled(lifecycle);
      await lifecycle.stop();
    }
  };
}

function buildContext(): AppContext {
  return {
    config: { filesPath: "/test/files", dataPath: "/test/data", port: 3000, reconcileInterval: 1800 },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fs: {
      mkdir: async () => {},
      rm: async () => {},
      readdir: async () => [],
      stat: async () => ({ isDirectory: () => false, size: 0 }),
      exists: async () => false,
      writeFile: async () => {},
      atomicWrite: async () => {},
      symlink: async () => {},
      unlink: async () => {},
    },
    dedup: { shouldProcess: () => true },
  };
}

async function findCbzImage(): Promise<string> {
  const entries = await listEntries(CBZ_PATH);
  const image = entries.find((e) => /\.(jpg|jpeg|png)$/i.test(e));

  if (!image) throw new Error("No image in test CBZ");

  return image;
}

// Each measured operation allocates and keeps RETAIN_KB, as a leaked buffer would. A
// single preallocated pool does not work as a control: it takes pages that are already
// resident, so filling it later adds nothing to RSS.
function makeRetainer(): () => void {
  if (RETAIN_KB <= 0) return () => {};

  const retained: Uint8Array[] = [];

  return () => {
    retained.push(new Uint8Array(RETAIN_KB * 1024).fill(1));
  };
}

const scenario = process.argv[2];

if (!scenario) throw new Error("Usage: bun leak-probe.ts <scenario>");

const tmpDir = join(tmpdir(), `leak-probe-${scenario}-${Date.now()}`);

await mkdir(tmpDir, { recursive: true });

const op = await buildScenario(scenario, tmpDir);

const retain = makeRetainer();

for (let i = 0; i < WARMUP_ITERATIONS; i++) {
  await op(i + 100000);
  Bun.gc(true);
}

// Samples live in a preallocated typed array so the probe itself adds no heap objects
// during measurement; the live-object delta then belongs to the workload alone.
const samples = new Float64Array(ITERATIONS / SAMPLE_EVERY + 1);

samples[0] = sampleRssFloorMb();

const typesBefore = heapStats().objectTypeCounts;

for (let i = 0; i < ITERATIONS; i++) {
  await op(i);
  retain();
  Bun.gc(true);

  if ((i + 1) % SAMPLE_EVERY === 0) {
    samples[(i + 1) / SAMPLE_EVERY] = sampleRssFloorMb();
  }
}

const typesAfter = heapStats().objectTypeCounts;

const result = {
  scenario,
  slopeKbPerIter: fitSlopeKbPerIter(samples),
  twoPointKbPerIter: ((samples[samples.length - 1]! - samples[0]!) * 1024) / ITERATIONS,
  objectsPerIter: sumTypeGrowth(typesBefore, typesAfter) / ITERATIONS,
  samples: samples.length,
  iterations: ITERATIONS,
  rssEndMb: getRssMb(),
  series: Array.from(samples, (mb) => Math.round(mb * 100) / 100),
};

await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

console.log(JSON.stringify(result));
