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

const ITERATIONS = 200;
const MAX_LEAK_PER_ITER_KB = 15;
const BUN_BUG_LEAK_KB = 250;

function getRssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function stabilizeMemory(): void {
  Bun.gc(true);
  Bun.gc(true);
}

interface LeakResult {
  totalMb: number;
  perIterKb: number;
}

function measureLeak(label: string, rssBefore: number, rssAfter: number, iterations: number): LeakResult {
  const totalMb = rssAfter - rssBefore;
  const perIterKb = (totalMb * 1024) / iterations;
  console.log(`  ${label}: ${totalMb.toFixed(1)} MB total, ${perIterKb.toFixed(1)} KB/iter (${iterations} iterations)`);
  return { totalMb, perIterKb };
}

describe("Memory leak detection", () => {
  test("raw Bun.spawn (echo, stdout ignore)", async () => {
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      const proc = Bun.spawn(["echo", "hello"], { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("Bun.spawn(echo, ignore)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB);
  });

  test("raw Bun.spawn (echo, stdout pipe, NO read)", async () => {
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      const proc = Bun.spawn(["echo", "hello"], { stdout: "pipe", stderr: "ignore" });
      await proc.exited;
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("Bun.spawn(echo, pipe, no read)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB);
  });

  test("raw Bun.spawn (echo, stdout pipe + read) — known Bun leak", async () => {
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      const proc = Bun.spawn(["echo", "hello"], { stdout: "pipe", stderr: "ignore" });
      await new Response(proc.stdout).arrayBuffer();
      await proc.exited;
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("Bun.spawn(echo, pipe+read)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(BUN_BUG_LEAK_KB);
  });

  test("raw Bun.spawn (magick, stdin pipe + stdout ignore)", async () => {
    const tmpDir = join(tmpdir(), `mem-magick-${Date.now()}`);
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      const dest = join(tmpDir, `img-${i}.jpg`);
      const proc = Bun.spawn(["magick", "-", "-resize", "100x100>", "-quality", "90", dest], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.stdin.write(VALID_PNG);
      await proc.stdin.end();
      await proc.exited;
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("Bun.spawn(magick, stdin pipe)", before, getRssMb(), ITERATIONS);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB);
  });

  test("spawnWithTimeout (echo)", async () => {
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await spawnWithTimeoutText({ command: ["echo", "hello"] });
      if (i % 20 === 0) Bun.gc(true);
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("spawnWithTimeout(echo)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB);
  });

  test("spawnWithTimeout (large stdout — zipinfo)", async () => {
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await spawnWithTimeoutText({ command: ["zipinfo", "-1", EPUB_PATH] });
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("spawnWithTimeout(zipinfo)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB);
  });

  test("listEntries (archive)", async () => {
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await listEntries(CBZ_PATH);
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("listEntries(cbz)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB);
  });

  test("readEntry (cover from archive)", async () => {
    const entries = await listEntries(CBZ_PATH);
    const image = entries.find((e) => /\.(jpg|jpeg|png)$/i.test(e));
    if (!image) throw new Error("No image in test CBZ");

    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      const buf = await readEntry(CBZ_PATH, image);
      if (!buf) throw new Error("Failed to read entry");
      if (i % 20 === 0) Bun.gc(true);
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("readEntry(cbz cover)", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB);
  });

  test("saveBufferAsImage (magick wrapper)", async () => {
    const tmpDir = join(tmpdir(), `mem-save-${Date.now()}`);
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await saveBufferAsImage(VALID_PNG, join(tmpDir, `img-${i}.jpg`), 100);
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("saveBufferAsImage", before, getRssMb(), ITERATIONS);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB);
  });

  test("saveCoverAndThumbnail (combined magick)", async () => {
    const tmpDir = join(tmpdir(), `mem-cover-${Date.now()}`);
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      await saveCoverAndThumbnail(VALID_PNG, join(tmpDir, `cover-${i}.jpg`), 600, join(tmpDir, `thumb-${i}.jpg`), 200);
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("saveCoverAndThumbnail", before, getRssMb(), ITERATIONS);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB);
  });

  test("new Response(ReadableStream).arrayBuffer() — known Bun leak", async () => {
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello world ".repeat(100)));
          controller.close();
        },
      });
      await new Response(stream).arrayBuffer();
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("Response(stream).arrayBuffer()", before, getRssMb(), ITERATIONS);
    expect(perIterKb).toBeLessThan(BUN_BUG_LEAK_KB);
  });

  test("full chain: readEntry + saveCoverAndThumbnail", async () => {
    const entries = await listEntries(CBZ_PATH);
    const image = entries.find((e) => /\.(jpg|jpeg|png)$/i.test(e));
    if (!image) throw new Error("No image in test CBZ");

    const tmpDir = join(tmpdir(), `mem-chain-${Date.now()}`);
    stabilizeMemory();
    const before = getRssMb();

    for (let i = 0; i < ITERATIONS; i++) {
      const buf = await readEntry(CBZ_PATH, image);
      if (buf) {
        await saveCoverAndThumbnail(buf, join(tmpDir, `cover-${i}.jpg`), 600, join(tmpDir, `thumb-${i}.jpg`), 200);
      }
      if (i % 20 === 0) Bun.gc(true);
    }

    stabilizeMemory();
    const { perIterKb } = measureLeak("readEntry+saveCoverAndThumbnail", before, getRssMb(), ITERATIONS);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    expect(perIterKb).toBeLessThan(MAX_LEAK_PER_ITER_KB * 3);
  }, 30000);
});
