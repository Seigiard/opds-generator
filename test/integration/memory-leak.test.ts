import { describe, test, expect } from "bun:test";
import { spawnWithTimeoutText } from "../../src/utils/process.ts";
import { saveBufferAsImage, saveCoverAndThumbnail } from "../../src/utils/image.ts";
import { listEntries, readEntry } from "../../src/utils/archive.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

const EPUB_PATH = "/app/files/test/Test Book - Test Author.epub";
const CBZ_PATH = "/app/files/test/bobby_make_believe_sample.cbz";

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x01, 0x03, 0x00, 0x00, 0x00, 0x25, 0xdb, 0x56, 0xca, 0x00, 0x00, 0x00, 0x06, 0x50, 0x4c, 0x54, 0x45, 0xff, 0x00, 0x00, 0xff, 0xff,
  0xff, 0x41, 0x1d, 0x34, 0x11, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
  0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const ITERATIONS = 300;
const MAX_LEAK_KB = 3;
const MAX_CHAIN_LEAK_KB = 1;

function getRssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function stabilize(): void {
  Bun.gc(true);
  Bun.gc(true);
  Bun.gc(true);
}

function measureLeak(label: string, rssBefore: number, rssAfter: number, iterations: number): number {
  const totalMb = rssAfter - rssBefore;
  const perIterKb = (totalMb * 1024) / iterations;
  console.log(`  ${label}: ${totalMb.toFixed(2)} MB total, ${perIterKb.toFixed(2)} KB/iter (${iterations} iters)`);
  return perIterKb;
}

async function warmup(fn: () => Promise<void>, count = 150): Promise<void> {
  for (let i = 0; i < count; i++) {
    await fn();
    if (i % 10 === 0) Bun.gc(true);
  }
  stabilize();
}

describe("Memory leak detection (target: 0 KB/iter)", () => {
  test("Bun.file().arrayBuffer()", async () => {
    const filePath = EPUB_PATH;
    await warmup(async () => {
      await Bun.file(filePath).arrayBuffer();
    });

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await Bun.file(filePath).arrayBuffer();
      Bun.gc(true);
    }

    stabilize();
    const perIterKb = measureLeak("Bun.file().arrayBuffer()", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("fs.readFile (Node API)", async () => {
    const { readFile } = await import("node:fs/promises");
    const filePath = EPUB_PATH;
    await warmup(async () => {
      await readFile(filePath);
    });

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await readFile(filePath);
      Bun.gc(true);
    }

    stabilize();
    const perIterKb = measureLeak("fs.readFile()", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("spawnWithTimeout (echo)", async () => {
    const op = () => spawnWithTimeoutText({ command: ["echo", "hello"] }).then(() => {});
    await warmup(op);

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await op();
      Bun.gc(true);
    }

    stabilize();
    const perIterKb = measureLeak("spawnWithTimeout(echo)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("spawnWithTimeout (zipinfo — real data)", async () => {
    const op = () => spawnWithTimeoutText({ command: ["zipinfo", "-1", EPUB_PATH] }).then(() => {});
    await warmup(op);

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await op();
      Bun.gc(true);
    }

    stabilize();
    const perIterKb = measureLeak("spawnWithTimeout(zipinfo)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("listEntries (archive)", async () => {
    await warmup(() => listEntries(CBZ_PATH).then(() => {}));

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await listEntries(CBZ_PATH);
      Bun.gc(true);
    }

    stabilize();
    const perIterKb = measureLeak("listEntries(cbz)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("readEntry (cover from archive)", async () => {
    const entries = await listEntries(CBZ_PATH);
    const image = entries.find((e) => /\.(jpg|jpeg|png)$/i.test(e));
    if (!image) throw new Error("No image in test CBZ");

    await warmup(() => readEntry(CBZ_PATH, image).then(() => {}));

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await readEntry(CBZ_PATH, image);
      Bun.gc(true);
    }

    stabilize();
    const perIterKb = measureLeak("readEntry(cbz cover)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("saveBufferAsImage (magick)", async () => {
    const tmpDir = join(tmpdir(), `mem-save-${Date.now()}`);
    await warmup(async () => {
      await saveBufferAsImage(VALID_PNG, join(tmpDir, `warmup-${Math.random()}.jpg`), 100);
    });

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await saveBufferAsImage(VALID_PNG, join(tmpDir, `img-${i}.jpg`), 100);
      Bun.gc(true);
    }

    stabilize();
    const perIterKb = measureLeak("saveBufferAsImage", before, getRssMb(), ITERATIONS);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    expect(perIterKb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("saveCoverAndThumbnail (combined magick)", async () => {
    const tmpDir = join(tmpdir(), `mem-cover-${Date.now()}`);
    await warmup(async () => {
      const n = Math.random().toString(36).slice(2);
      await saveCoverAndThumbnail(VALID_PNG, join(tmpDir, `w-c-${n}.jpg`), 600, join(tmpDir, `w-t-${n}.jpg`), 200);
    });

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await saveCoverAndThumbnail(VALID_PNG, join(tmpDir, `cover-${i}.jpg`), 600, join(tmpDir, `thumb-${i}.jpg`), 200);
      Bun.gc(true);
    }

    stabilize();
    const perIterKb = measureLeak("saveCoverAndThumbnail", before, getRssMb(), ITERATIONS);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    expect(perIterKb).toBeLessThan(MAX_LEAK_KB);
  }, 30000);

  test("full chain: readEntry + saveCoverAndThumbnail", async () => {
    const entries = await listEntries(CBZ_PATH);
    const image = entries.find((e) => /\.(jpg|jpeg|png)$/i.test(e));
    if (!image) throw new Error("No image in test CBZ");

    const tmpDir = join(tmpdir(), `mem-chain-${Date.now()}`);
    await warmup(async () => {
      const buf = await readEntry(CBZ_PATH, image);
      if (buf) {
        const n = Math.random().toString(36).slice(2);
        await saveCoverAndThumbnail(buf, join(tmpDir, `w-c-${n}.jpg`), 600, join(tmpDir, `w-t-${n}.jpg`), 200);
      }
    });

    stabilize();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      const buf = await readEntry(CBZ_PATH, image);
      if (buf) {
        await saveCoverAndThumbnail(buf, join(tmpDir, `cover-${i}.jpg`), 600, join(tmpDir, `thumb-${i}.jpg`), 200);
      }
      Bun.gc(true);
    }

    stabilize();
    const perIterKb = measureLeak("readEntry+saveCoverAndThumbnail", before, getRssMb(), ITERATIONS);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    expect(perIterKb).toBeLessThan(MAX_CHAIN_LEAK_KB);
  }, 60000);
});
