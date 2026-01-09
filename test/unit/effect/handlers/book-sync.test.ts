import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../../src/effect/services.ts";
import { bookSync } from "../../../../src/effect/handlers/book-sync.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import type { LogContext } from "../../../../src/logging/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, readdir, stat, readFile, lstat } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `opds-book-sync-test-${Date.now()}`);
const FILES_DIR = join(TEST_DIR, "files");
const DATA_DIR = join(TEST_DIR, "data");
const FIXTURES_DIR = join(import.meta.dir, "../../../../files/test");

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string; ctx?: LogContext }>,
  warnCalls: [] as Array<{ tag: string; msg: string }>,
  reset() {
    this.infoCalls = [];
    this.warnCalls = [];
  },
};

const TestConfigService = Layer.succeed(ConfigService, {
  filesPath: FILES_DIR,
  dataPath: DATA_DIR,
  port: 3000,
});

const TestLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg, ctx) =>
    Effect.sync(() => {
      mockLogger.infoCalls.push({ tag, msg, ctx });
    }),
  warn: (tag, msg) =>
    Effect.sync(() => {
      mockLogger.warnCalls.push({ tag, msg });
    }),
  error: () => Effect.void,
  debug: () => Effect.void,
});

const RealFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: (path, options) => Effect.promise(() => mkdir(path, options)),
  rm: (path, options) => Effect.promise(() => rm(path, options)),
  readdir: (path) => Effect.promise(() => readdir(path)),
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
      await fs.symlink(target, path);
    }),
  unlink: (path) =>
    Effect.promise(async () => {
      const fs = await import("node:fs/promises");
      await fs.unlink(path);
    }),
});

const TestLayer = Layer.mergeAll(TestConfigService, TestLoggerService, RealFileSystemService);

const bookCreatedEvent = (relativePath: string): EventType => {
  const parts = relativePath.split("/");
  const name = parts.pop()!;
  const parent = join(FILES_DIR, parts.join("/"));
  return { _tag: "BookCreated", parent, name };
};

describe("bookSync handler", () => {
  beforeEach(async () => {
    mockLogger.reset();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(FILES_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("returns empty array for non-BookCreated events", async () => {
    const event: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" };
    const cascades = await Effect.runPromise(Effect.provide(bookSync(event), TestLayer));

    expect(cascades).toEqual([]);
  });

  test("creates data directory for book", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await Effect.runPromise(Effect.provide(bookSync(bookCreatedEvent("test.epub")), TestLayer));

    const dataDir = join(DATA_DIR, "test.epub");
    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("creates entry.xml with book metadata", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await Effect.runPromise(Effect.provide(bookSync(bookCreatedEvent("test.epub")), TestLayer));

    const entryPath = join(DATA_DIR, "test.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");

    expect(entryContent).toContain("<entry");
    expect(entryContent).toContain("test");
    expect(entryContent).toContain("urn:opds:book:");
  });

  test("creates symlink to original file", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await Effect.runPromise(Effect.provide(bookSync(bookCreatedEvent("test.epub")), TestLayer));

    const symlinkPath = join(DATA_DIR, "test.epub", "test.epub");
    const linkStat = await lstat(symlinkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  test("extracts metadata from real EPUB", async () => {
    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(FILES_DIR, "Test Book - Test Author.epub");

    await mkdir(join(FILES_DIR), { recursive: true });
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    await Effect.runPromise(Effect.provide(bookSync(bookCreatedEvent("Test Book - Test Author.epub")), TestLayer));

    const entryPath = join(DATA_DIR, "Test Book - Test Author.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");

    expect(entryContent).toContain("Test Book");
    expect(entryContent).toContain("Test Author");
  });

  test("extracts cover from real EPUB", async () => {
    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(FILES_DIR, "Test Book - Test Author.epub");

    await mkdir(join(FILES_DIR), { recursive: true });
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    await Effect.runPromise(Effect.provide(bookSync(bookCreatedEvent("Test Book - Test Author.epub")), TestLayer));

    const coverPath = join(DATA_DIR, "Test Book - Test Author.epub", "cover.jpg");
    const thumbPath = join(DATA_DIR, "Test Book - Test Author.epub", "thumb.jpg");

    const coverExists = await stat(coverPath)
      .then(() => true)
      .catch(() => false);
    const thumbExists = await stat(thumbPath)
      .then(() => true)
      .catch(() => false);

    expect(coverExists).toBe(true);
    expect(thumbExists).toBe(true);
  });

  test("handles nested folder structure", async () => {
    const nestedPath = join(FILES_DIR, "Fiction", "Author");
    await mkdir(nestedPath, { recursive: true });
    const bookPath = join(nestedPath, "book.epub");
    await Bun.write(bookPath, "fake epub content");

    await Effect.runPromise(Effect.provide(bookSync(bookCreatedEvent("Fiction/Author/book.epub")), TestLayer));

    const dataDir = join(DATA_DIR, "Fiction", "Author", "book.epub");
    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("uses filename as title when metadata unavailable", async () => {
    const bookPath = join(FILES_DIR, "My_Great_Book.epub");
    await Bun.write(bookPath, "fake epub content");

    await Effect.runPromise(Effect.provide(bookSync(bookCreatedEvent("My_Great_Book.epub")), TestLayer));

    const entryPath = join(DATA_DIR, "My_Great_Book.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");

    expect(entryContent).toContain("My Great Book");
  });

  test("logs processing info", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await Effect.runPromise(Effect.provide(bookSync(bookCreatedEvent("test.epub")), TestLayer));

    expect(mockLogger.infoCalls.some((c) => c.tag === "BookSync" && c.msg.includes("Processing"))).toBe(true);
    expect(mockLogger.infoCalls.some((c) => c.tag === "BookSync" && c.msg.includes("Done"))).toBe(true);
  });
});
