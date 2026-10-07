import { basename, join } from "node:path";
import { describe, test, expect, beforeEach } from "bun:test";
import { Effect } from "effect";
import { FileSystemNotFound } from "../../../src/effect-file-system.ts";
import { runAsPromiseHandler, type EffectHandler } from "../../../src/processing/effect-handler.ts";
import { folderCleanupEffect } from "../../../src/processing/handlers/folder-cleanup-effect.ts";
import { folderSyncEffect } from "../../../src/processing/handlers/folder-sync-effect.ts";
import { bookCleanupEffect } from "../../../src/processing/handlers/book-cleanup-effect.ts";
import { createEffectFileSystemTestDouble } from "../../helpers/effect-file-system.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/processing/types.ts";
import type { LogContext } from "../../../src/logging/types.ts";
import type { Result } from "neverthrow";

// Mock tracking
interface MockFs {
  mkdirCalls: Array<{ path: string; options?: { recursive?: boolean } }>;
  rmCalls: Array<{ path: string; options?: { recursive?: boolean } }>;
  writeCalls: Array<{ path: string; content: string }>;
  unlinkCalls: string[];
  symlinkCalls: Array<{ target: string; path: string }>;
  reset: () => void;
}

interface MockLogger {
  infoCalls: Array<{ tag: string; msg: string; ctx?: LogContext }>;
  warnCalls: Array<{ tag: string; msg: string; ctx?: LogContext }>;
  errorCalls: Array<{ tag: string; msg: string; error?: unknown }>;
  debugCalls: Array<{ tag: string; msg: string; ctx?: LogContext }>;
  reset: () => void;
}

const createMockFs = (): MockFs => ({
  mkdirCalls: [],
  rmCalls: [],
  writeCalls: [],
  unlinkCalls: [],
  symlinkCalls: [],
  reset() {
    this.mkdirCalls = [];
    this.rmCalls = [];
    this.writeCalls = [];
    this.unlinkCalls = [];
    this.symlinkCalls = [];
  },
});

const createMockLogger = (): MockLogger => ({
  infoCalls: [],
  warnCalls: [],
  errorCalls: [],
  debugCalls: [],
  reset() {
    this.infoCalls = [];
    this.warnCalls = [];
    this.errorCalls = [];
    this.debugCalls = [];
  },
});

const mockFs = createMockFs();

const mockLogger = createMockLogger();

// Helper to create events
const folderDeletedEvent = (parent: string, name: string): EventType => ({
  _tag: "FolderDeleted",
  parent,
  name,
});

const folderCreatedEvent = (parent: string, name: string): EventType => ({
  _tag: "FolderCreated",
  parent,
  name,
});

const bookDeletedEvent = (parent: string, name: string): EventType => ({
  _tag: "BookDeleted",
  parent,
  name,
});

const asyncDeps: HandlerDeps = {
  config: { filesPath: "/test/books", dataPath: "/test/data", port: 8080, reconcileInterval: 1800 },
  logger: {
    info: (tag, msg, ctx) => mockLogger.infoCalls.push({ tag, msg, ctx }),
    warn: (tag, msg, ctx) => mockLogger.warnCalls.push({ tag, msg, ctx }),
    error: (tag, msg, error) => mockLogger.errorCalls.push({ tag, msg, error }),
    debug: (tag, msg, ctx) => mockLogger.debugCalls.push({ tag, msg, ctx }),
  },
  fs: {
    mkdir: async (path, options) => {
      mockFs.mkdirCalls.push({ path, options });
    },
    rm: async (path, options) => {
      mockFs.rmCalls.push({ path, options });
    },
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => false, size: 0 }),
    exists: async () => false,
    writeFile: async (path, content) => {
      mockFs.writeCalls.push({ path, content });
    },
    atomicWrite: async (path, content) => {
      mockFs.writeCalls.push({ path, content });
    },
    symlink: async (target, path) => {
      mockFs.symlinkCalls.push({ target, path });
    },
    unlink: async (path) => {
      mockFs.unlinkCalls.push(path);
    },
  },
};

const asCleanupHandler =
  (handler: EffectHandler): ((event: EventType, handlerDeps: HandlerDeps) => Promise<Result<readonly EventType[], Error>>) =>
  (event, handlerDeps) =>
    runAsPromiseHandler(handler, event, handlerDeps);

const bookCleanup = asCleanupHandler(bookCleanupEffect);

const folderCleanup = asCleanupHandler(folderCleanupEffect);

const folderSync = asCleanupHandler(folderSyncEffect);

describe("Processing Handlers", () => {
  beforeEach(() => {
    mockFs.reset();
    mockLogger.reset();
  });

  describe("folderCleanup", () => {
    test("removes data directory for deleted folder", async () => {
      const result = await folderCleanup(folderDeletedEvent("/test/books/Fiction/", "Author"), asyncDeps);

      expect(result.isOk()).toBe(true);
      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/Author");
      expect(mockFs.rmCalls[0]!.options?.recursive).toBe(true);
    });

    test("handles nested folder paths correctly", async () => {
      const result = await folderCleanup(folderDeletedEvent("/test/books/Fiction/SciFi/", "Isaac Asimov"), asyncDeps);

      expect(result.isOk()).toBe(true);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/SciFi/Isaac Asimov");
    });
  });

  describe("stale deletes", () => {
    const existing = (path: string): HandlerDeps => ({ ...asyncDeps, fs: { ...asyncDeps.fs, exists: async (p) => p === path } });

    test("bookCleanup keeps the entry when the book exists in the books directory", async () => {
      // #given the book is back in /books by the time the delete runs
      const deps = existing("/test/books/Fiction/Book.epub");
      // #when
      const result = await bookCleanup(bookDeletedEvent("/test/books/Fiction/", "Book.epub"), deps);
      // #then
      expect({ events: result._unsafeUnwrap(), rm: mockFs.rmCalls }).toEqual({ events: [], rm: [] });
    });

    test("folderCleanup keeps the data when the folder exists in the books directory", async () => {
      // #given
      const deps = existing("/test/books/Fiction/Author");
      // #when
      const result = await folderCleanup(folderDeletedEvent("/test/books/Fiction/", "Author"), deps);
      // #then
      expect({ events: result._unsafeUnwrap(), rm: mockFs.rmCalls }).toEqual({ events: [], rm: [] });
    });
  });

  describe("folderSync", () => {
    test("creates data directory for new folder", async () => {
      const result = await folderSync(folderCreatedEvent("/test/books/", "Fiction"), asyncDeps);
      expect(result.isOk()).toBe(true);
      expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction")).toBe(true);
    });

    test("creates _entry.xml for non-root folders", async () => {
      const result = await folderSync(folderCreatedEvent("/test/books/", "Fiction"), asyncDeps);
      expect(result.isOk()).toBe(true);
      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite).toBeDefined();
      expect(entryWrite?.content).toContain("<entry");
    });

    test("does not create _entry.xml for root folder", async () => {
      const result = await folderSync(folderCreatedEvent("/test/books/", ""), asyncDeps);
      expect(result.isOk()).toBe(true);
      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite).toBeUndefined();
    });

    test("includes subsection link in _entry.xml", async () => {
      const result = await folderSync(folderCreatedEvent("/test/books/", "Fiction"), asyncDeps);
      expect(result.isOk()).toBe(true);
      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite?.content).toContain("Fiction/feed.xml");
    });

    test("returns cascade event to generate root feed.xml", async () => {
      const result = await folderSync(folderCreatedEvent("/test/books/", ""), asyncDeps);
      expect(result.isOk()).toBe(true);
      const cascades = result._unsafeUnwrap();
      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/test/data" });
    });

    test("returns cascade events to generate the folder feed.xml and list the folder in its parent", async () => {
      const result = await folderSync(folderCreatedEvent("/test/books/", "Fiction"), asyncDeps);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([
        { _tag: "FolderMetaSyncRequested", path: "/test/data/Fiction" },
        { _tag: "FolderMetaSyncRequested", path: "/test/data" },
      ]);
    });
  });

  describe("folderSync of a folder that already has contents", () => {
    // inotifywait adds its watch to a new folder after the folder's create event, so files copied in meanwhile never raise events.
    const tree = new Map([
      [
        "/test/books/Copy",
        [
          { name: "a.epub", dir: false },
          { name: "notes.txt.bak", dir: false },
          { name: ".hidden.epub", dir: false },
          { name: "Nested", dir: true },
        ],
      ],
      ["/test/books/Copy/Nested", [{ name: "b.fb2", dir: false }]],
    ]);

    const entriesOf = (path: string) => tree.get(path) ?? [];

    const depsWithTree = (existing: string[] = []): HandlerDeps => ({
      ...asyncDeps,
      fs: {
        ...asyncDeps.fs,
        readdir: async (path) => entriesOf(path).map((e) => e.name),
        stat: async (path) => ({
          isDirectory: () => entriesOf(join(path, "..")).some((e) => e.name === basename(path) && e.dir),
          size: 1,
        }),
        exists: async (path) => existing.includes(path),
      },
    });

    test("submits BookCreated and FolderCreated for what is already inside", async () => {
      const result = await folderSync(folderCreatedEvent("/test/books", "Copy"), depsWithTree());

      const cascades = result._unsafeUnwrap();
      expect(cascades).toContainEqual({ _tag: "BookCreated", parent: "/test/books/Copy", name: "a.epub" });
      expect(cascades).toContainEqual({ _tag: "FolderCreated", parent: "/test/books/Copy", name: "Nested" });
      expect(cascades.filter((e) => e._tag === "BookCreated")).toHaveLength(1);
    });

    test("skips a book that already has its entry", async () => {
      const result = await folderSync(folderCreatedEvent("/test/books", "Copy"), depsWithTree(["/test/data/Copy/a.epub/entry.xml"]));

      expect(result._unsafeUnwrap().some((e) => e._tag === "BookCreated")).toBe(false);
    });
  });

  describe("bookCleanup", () => {
    test("removes data directory for deleted book", async () => {
      const result = await bookCleanup(bookDeletedEvent("/test/books/Fiction/", "book.epub"), asyncDeps);

      expect(result.isOk()).toBe(true);
      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/book.epub");
      expect(mockFs.rmCalls[0]!.options?.recursive).toBe(true);
    });

    test("returns cascade event to regenerate parent feed", async () => {
      const result = await bookCleanup(bookDeletedEvent("/test/books/Fiction/", "book.epub"), asyncDeps);

      expect(result.isOk()).toBe(true);
      const cascades = result._unsafeUnwrap();
      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/test/data/Fiction" });
    });
  });

  describe("folderCleanup cascade", () => {
    test("returns cascade event to regenerate parent feed for nested folders", async () => {
      const result = await folderCleanup(folderDeletedEvent("/test/books/Fiction/", "SciFi"), asyncDeps);

      expect(result.isOk()).toBe(true);
      const cascades = result._unsafeUnwrap();
      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/test/data/Fiction" });
    });

    test("returns a root refresh for top-level folder deletion, so the root feed drops the folder", async () => {
      const result = await folderCleanup(folderDeletedEvent("/test/books/", "Fiction"), asyncDeps);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([{ _tag: "FolderMetaSyncRequested", path: "/test/data" }]);
    });
  });

  test("folderCleanup effect recovers when the data directory is already gone", async () => {
    // #given
    const missingDataDir = "/test/data/Fiction";

    const effectFs = createEffectFileSystemTestDouble({
      exists: () => Effect.succeed(false),
      rm: () =>
        Effect.fail(new FileSystemNotFound({ operation: "rm", path: missingDataDir, message: `rm ${missingDataDir} failed: ENOENT` })),
    });

    // #when
    const result = await runAsPromiseHandler(folderCleanupEffect, folderDeletedEvent("/test/books/", "Fiction"), asyncDeps, effectFs);

    // #then
    expect(result._unsafeUnwrap()).toEqual([{ _tag: "FolderMetaSyncRequested", path: "/test/data" }]);
  });
});
