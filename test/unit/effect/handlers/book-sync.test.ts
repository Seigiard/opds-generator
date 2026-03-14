import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { bookSync } from "../../../../src/effect/handlers/book-sync.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, readdir, stat, readFile, lstat, rename, symlink, unlink } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `opds-book-sync-test-${Date.now()}`);
const FILES_DIR = join(TEST_DIR, "files");
const DATA_DIR = join(TEST_DIR, "data");
const FIXTURES_DIR = join(import.meta.dir, "../../../../files/test");

const deps: HandlerDeps = {
  config: { filesPath: FILES_DIR, dataPath: DATA_DIR, port: 3000, reconcileInterval: 1800 },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fs: {
    mkdir: async (path, options) => { await mkdir(path, options); },
    rm: (path, options) => rm(path, options),
    readdir: (path) => readdir(path),
    stat: async (path) => { const s = await stat(path); return { isDirectory: () => s.isDirectory(), size: s.size }; },
    exists: async (path) => { try { await stat(path); return true; } catch { return false; } },
    writeFile: async (path, content) => { await Bun.write(path, content); },
    atomicWrite: async (path, content) => { await Bun.write(path, content); },
    symlink: async (target, path) => { try { await unlink(path); } catch {} await symlink(target, path); },
    unlink: (path) => unlink(path),
  },
};

const bookCreatedEvent = (relativePath: string): EventType => {
  const parts = relativePath.split("/");
  const name = parts.pop()!;
  const parent = join(FILES_DIR, parts.join("/"));
  return { _tag: "BookCreated", parent, name };
};

describe("bookSync handler", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(FILES_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("returns empty array for non-BookCreated events", async () => {
    const event: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" };
    const result = await bookSync(event, deps);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("creates data directory for book", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("test.epub"), deps);

    const dataDir = join(DATA_DIR, "test.epub");
    const exists = await stat(dataDir).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  test("creates entry.xml with book metadata", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("test.epub"), deps);

    const entryPath = join(DATA_DIR, "test.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");
    expect(entryContent).toContain("<entry");
    expect(entryContent).toContain("test");
    expect(entryContent).toContain("urn:opds:book:");
  });

  test("creates symlink to original file", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("test.epub"), deps);

    const symlinkPath = join(DATA_DIR, "test.epub", "test.epub");
    const linkStat = await lstat(symlinkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  test("extracts metadata from real EPUB", async () => {
    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(FILES_DIR, "Test Book - Test Author.epub");
    await mkdir(FILES_DIR, { recursive: true });
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    await bookSync(bookCreatedEvent("Test Book - Test Author.epub"), deps);

    const entryPath = join(DATA_DIR, "Test Book - Test Author.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");
    expect(entryContent).toContain("Test Book");
    expect(entryContent).toContain("Test Author");
  });

  test("extracts cover from real EPUB", async () => {
    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(FILES_DIR, "Test Book - Test Author.epub");
    await mkdir(FILES_DIR, { recursive: true });
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    await bookSync(bookCreatedEvent("Test Book - Test Author.epub"), deps);

    const coverPath = join(DATA_DIR, "Test Book - Test Author.epub", "cover.jpg");
    const thumbPath = join(DATA_DIR, "Test Book - Test Author.epub", "thumb.jpg");
    const coverExists = await stat(coverPath).then(() => true).catch(() => false);
    const thumbExists = await stat(thumbPath).then(() => true).catch(() => false);
    expect(coverExists).toBe(true);
    expect(thumbExists).toBe(true);
  });

  test("handles nested folder structure", async () => {
    const nestedPath = join(FILES_DIR, "Fiction", "Author");
    await mkdir(nestedPath, { recursive: true });
    const bookPath = join(nestedPath, "book.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("Fiction/Author/book.epub"), deps);

    const dataDir = join(DATA_DIR, "Fiction", "Author", "book.epub");
    const exists = await stat(dataDir).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  test("uses filename as title when metadata unavailable", async () => {
    const bookPath = join(FILES_DIR, "My_Great_Book.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("My_Great_Book.epub"), deps);

    const entryPath = join(DATA_DIR, "My_Great_Book.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");
    expect(entryContent).toContain("My Great Book");
  });
});
