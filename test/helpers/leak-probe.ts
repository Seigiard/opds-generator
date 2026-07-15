/**
 * Memory-leak probe: runs one scenario in a pristine process and prints a JSON
 * result line. Spawned per-scenario by test/integration/memory-leak.test.ts —
 * tests sharing a process contaminate each other's RSS trend (allocator arenas
 * decommitted by one test recommit during the next, faking +15-25 KB/iter growth
 * on leak-free code), so each measurement gets its own process.
 */
import { spawnWithTimeoutText } from "../../src/utils/process.ts";
import { saveBufferAsImage, saveCoverAndThumbnail } from "../../src/utils/image.ts";
import { listEntries, readEntry } from "../../src/utils/archive.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm } from "node:fs/promises";

const EPUB_PATH = "/app/files/test/Test Book - Test Author.epub";
const CBZ_PATH = "/app/files/test/bobby_make_believe_sample.cbz";

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x01, 0x03, 0x00, 0x00, 0x00, 0x25, 0xdb, 0x56, 0xca, 0x00, 0x00, 0x00, 0x06, 0x50, 0x4c, 0x54, 0x45, 0xff, 0x00, 0x00, 0xff, 0xff,
  0xff, 0x41, 0x1d, 0x34, 0x11, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
  0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const ITERATIONS = 300;
const SAMPLE_EVERY = 10;
const WARMUP_ITERATIONS = 150;

type RssSample = { iter: number; rssMb: number };
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
function fitSlopeKbPerIter(samples: RssSample[]): number {
  const n = samples.length;
  const meanX = samples.reduce((sum, s) => sum + s.iter, 0) / n;
  const meanY = samples.reduce((sum, s) => sum + s.rssMb, 0) / n;
  let covXY = 0;
  let varX = 0;
  for (const s of samples) {
    covXY += (s.iter - meanX) * (s.rssMb - meanY);
    varX += (s.iter - meanX) ** 2;
  }
  return (covXY / varX) * 1024;
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
    default:
      throw new Error(`Unknown scenario: ${name}`);
  }
}

async function findCbzImage(): Promise<string> {
  const entries = await listEntries(CBZ_PATH);
  const image = entries.find((e) => /\.(jpg|jpeg|png)$/i.test(e));
  if (!image) throw new Error("No image in test CBZ");
  return image;
}

const scenario = process.argv[2];
if (!scenario) throw new Error("Usage: bun leak-probe.ts <scenario>");

const tmpDir = join(tmpdir(), `leak-probe-${scenario}-${Date.now()}`);
const op = await buildScenario(scenario, tmpDir);

for (let i = 0; i < WARMUP_ITERATIONS; i++) {
  await op(i + 100000);
  if (i % 10 === 0) Bun.gc(true);
}

const samples: RssSample[] = [{ iter: 0, rssMb: sampleRssFloorMb() }];
for (let i = 0; i < ITERATIONS; i++) {
  await op(i);
  Bun.gc(true);
  if ((i + 1) % SAMPLE_EVERY === 0) {
    samples.push({ iter: i + 1, rssMb: sampleRssFloorMb() });
  }
}

const first = samples[0] as RssSample;
const last = samples[samples.length - 1] as RssSample;
const result = {
  scenario,
  slopeKbPerIter: fitSlopeKbPerIter(samples),
  twoPointKbPerIter: ((last.rssMb - first.rssMb) * 1024) / ITERATIONS,
  samples: samples.length,
  iterations: ITERATIONS,
  rssEndMb: getRssMb(),
};
await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
console.log(JSON.stringify(result));
