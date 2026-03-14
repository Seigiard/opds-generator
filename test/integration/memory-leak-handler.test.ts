import { describe, test, expect, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../src/effect/services.ts";
import { bookSync } from "../../src/effect/handlers/book-sync.ts";
import { folderSync } from "../../src/effect/handlers/folder-sync.ts";
import { folderMetaSync } from "../../src/effect/handlers/folder-meta-sync.ts";
import type { EventType } from "../../src/effect/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `opds-memleak-handler-${Date.now()}`);
const FILES_DIR = join(TEST_DIR, "files");
const DATA_DIR = join(TEST_DIR, "data");
const FIXTURES_DIR = "/app/files/test";

const ITERATIONS = 100;
const MAX_LEAK_KB = 1;

const TestConfigService = Layer.succeed(ConfigService, {
  filesPath: FILES_DIR,
  dataPath: DATA_DIR,
  port: 3000,
});

const SilentLoggerService = Layer.succeed(LoggerService, {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  debug: () => Effect.void,
});

const RealFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: (path, options) => Effect.promise(() => mkdir(path, options)),
  rm: (path, options) => Effect.promise(() => rm(path, options)),
  readdir: (path) =>
    Effect.promise(async () => {
      const fs = await import("node:fs/promises");
      return fs.readdir(path);
    }),
  stat: (path) =>
    Effect.promise(async () => {
      const s = await stat(path);
      return { isDirectory: () => s.isDirectory(), size: s.size };
    }),
  exists: (path) =>
    Effect.promise(async () => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    }),
  writeFile: (path, content) => Effect.promise(() => Bun.write(path, content)),
  atomicWrite: (path, content) => Effect.promise(() => Bun.write(path, content)),
  symlink: (target, path) =>
    Effect.promise(async () => {
      const fs = await import("node:fs/promises");
      try {
        await fs.unlink(path);
      } catch {}
      await fs.symlink(target, path);
    }),
  unlink: (path) =>
    Effect.promise(async () => {
      const fs = await import("node:fs/promises");
      await fs.unlink(path);
    }),
});

const TestLayer = Layer.mergeAll(TestConfigService, SilentLoggerService, RealFileSystemService);

function getRssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function stabilize(): void {
  Bun.gc(true);
  Bun.gc(true);
  Bun.gc(true);
}

async function processOneBook(folderName: string, bookFile: string): Promise<void> {
  const folderPath = join(FILES_DIR, folderName);
  await mkdir(folderPath, { recursive: true });

  const srcPath = join(FIXTURES_DIR, bookFile);
  const destPath = join(folderPath, bookFile);
  const content = await Bun.file(srcPath).arrayBuffer();
  await Bun.write(destPath, content);

  const folderEvent: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: folderName };
  await Effect.runPromise(Effect.provide(folderSync(folderEvent), TestLayer));

  const bookEvent: EventType = { _tag: "BookCreated", parent: folderPath, name: bookFile };
  await Effect.runPromise(Effect.provide(bookSync(bookEvent), TestLayer));

  const folderDataPath = join(DATA_DIR, folderName);
  const metaEvent: EventType = { _tag: "FolderMetaSyncRequested", path: folderDataPath };
  await Effect.runPromise(Effect.provide(folderMetaSync(metaEvent), TestLayer));

  const rootEvent: EventType = { _tag: "FolderMetaSyncRequested", path: DATA_DIR };
  await Effect.runPromise(Effect.provide(folderMetaSync(rootEvent), TestLayer));

  await rm(join(DATA_DIR, folderName), { recursive: true, force: true });
  await rm(folderPath, { recursive: true, force: true });
}

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

async function runHandlerTest(label: string, bookFile: string): Promise<void> {
  await mkdir(FILES_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  for (let i = 0; i < 30; i++) {
    await processOneBook(`warmup-${label}-${i}`, bookFile);
    if (i % 5 === 0) Bun.gc(true);
  }
  stabilize();

  const before = getRssMb();

  for (let i = 0; i < ITERATIONS; i++) {
    await processOneBook(`test-${label}-${i}`, bookFile);
    Bun.gc(true);
  }

  stabilize();
  const after = getRssMb();
  const totalMb = after - before;
  const perIterKb = (totalMb * 1024) / ITERATIONS;
  console.log(`  bookSync(${label}): ${totalMb.toFixed(2)} MB total, ${perIterKb.toFixed(2)} KB/iter (${ITERATIONS} iters)`);
  expect(perIterKb).toBeLessThan(MAX_LEAK_KB);
}

describe("Full handler memory leak (target: 0 KB/iter)", () => {
  test("PDF handler", () => runHandlerTest("pdf", "Test Book - Test Author.pdf"), 120000);
  test("CBZ handler", () => runHandlerTest("cbz", "bobby_make_believe_sample.cbz"), 120000);
  test("EPUB handler", () => runHandlerTest("epub", "Test Book - Test Author.epub"), 120000);
});
