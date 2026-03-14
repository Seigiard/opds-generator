import { describe, test, expect, beforeEach } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../src/effect/services.ts";
import { folderCleanup } from "../../../src/effect/handlers/folder-cleanup.ts";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import { bookCleanup } from "../../../src/effect/handlers/book-cleanup.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/effect/types.ts";
import type { LogContext } from "../../../src/logging/types.ts";

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

const TestConfigService = Layer.succeed(ConfigService, {
  filesPath: "/test/books",
  dataPath: "/test/data",
  port: 8080,
});

const TestLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg, ctx) =>
    Effect.sync(() => {
      mockLogger.infoCalls.push({ tag, msg, ctx });
    }),
  warn: (tag, msg, ctx) =>
    Effect.sync(() => {
      mockLogger.warnCalls.push({ tag, msg, ctx });
    }),
  error: (tag, msg, error) =>
    Effect.sync(() => {
      mockLogger.errorCalls.push({ tag, msg, error });
    }),
  debug: (tag, msg, ctx) =>
    Effect.sync(() => {
      mockLogger.debugCalls.push({ tag, msg, ctx });
    }),
});

const TestFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: (path, options) =>
    Effect.sync(() => {
      mockFs.mkdirCalls.push({ path, options });
    }),
  rm: (path, options) =>
    Effect.sync(() => {
      mockFs.rmCalls.push({ path, options });
    }),
  readdir: (_path) => Effect.succeed([]),
  stat: (_path) => Effect.succeed({ isDirectory: () => false, size: 0 }),
  exists: (_path) => Effect.succeed(false),
  writeFile: (path, content) =>
    Effect.sync(() => {
      mockFs.writeCalls.push({ path, content });
    }),
  atomicWrite: (path, content) =>
    Effect.sync(() => {
      mockFs.writeCalls.push({ path, content });
    }),
  symlink: (target, path) =>
    Effect.sync(() => {
      mockFs.symlinkCalls.push({ target, path });
    }),
  unlink: (path) =>
    Effect.sync(() => {
      mockFs.unlinkCalls.push(path);
    }),
});

const TestLayer = Layer.mergeAll(TestConfigService, TestLoggerService, TestFileSystemService);

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

describe("Effect Handlers", () => {
  beforeEach(() => {
    mockFs.reset();
    mockLogger.reset();
  });

  describe("folderCleanup", () => {
    test("removes data directory for deleted folder", async () => {
      const effect = folderCleanup(folderDeletedEvent("/test/books/Fiction/", "Author"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/Author");
      expect(mockFs.rmCalls[0]!.options?.recursive).toBe(true);
    });

    test("handles nested folder paths correctly", async () => {
      const effect = folderCleanup(folderDeletedEvent("/test/books/Fiction/SciFi/", "Isaac Asimov"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/SciFi/Isaac Asimov");
    });
  });

  describe("folderSync", () => {
    const asyncDeps: HandlerDeps = {
      config: { filesPath: "/test/books", dataPath: "/test/data", port: 8080, reconcileInterval: 1800 },
      logger: {
        info: (tag, msg, ctx) => mockLogger.infoCalls.push({ tag, msg, ctx }),
        warn: (tag, msg, ctx) => mockLogger.warnCalls.push({ tag, msg, ctx }),
        error: (tag, msg, error) => mockLogger.errorCalls.push({ tag, msg, error }),
        debug: (tag, msg, ctx) => mockLogger.debugCalls.push({ tag, msg, ctx }),
      },
      fs: {
        mkdir: async (path, options) => { mockFs.mkdirCalls.push({ path, options }); },
        rm: async (path, options) => { mockFs.rmCalls.push({ path, options }); },
        readdir: async () => [],
        stat: async () => ({ isDirectory: () => false, size: 0 }),
        exists: async () => false,
        writeFile: async (path, content) => { mockFs.writeCalls.push({ path, content }); },
        atomicWrite: async (path, content) => { mockFs.writeCalls.push({ path, content }); },
        symlink: async (target, path) => { mockFs.symlinkCalls.push({ target, path }); },
        unlink: async (path) => { mockFs.unlinkCalls.push(path); },
      },
    };

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

    test("returns cascade event to generate folder feed.xml", async () => {
      const result = await folderSync(folderCreatedEvent("/test/books/", "Fiction"), asyncDeps);
      expect(result.isOk()).toBe(true);
      const cascades = result._unsafeUnwrap();
      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/test/data/Fiction" });
    });
  });

  describe("bookCleanup", () => {
    test("removes data directory for deleted book", async () => {
      const effect = bookCleanup(bookDeletedEvent("/test/books/Fiction/", "book.epub"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/book.epub");
      expect(mockFs.rmCalls[0]!.options?.recursive).toBe(true);
    });

    test("returns cascade event to regenerate parent feed", async () => {
      const effect = bookCleanup(bookDeletedEvent("/test/books/Fiction/", "book.epub"));

      const cascades = await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({
        _tag: "FolderMetaSyncRequested",
        path: "/test/data/Fiction",
      });
    });
  });

  describe("folderCleanup cascade", () => {
    test("returns cascade event to regenerate parent feed for nested folders", async () => {
      const effect = folderCleanup(folderDeletedEvent("/test/books/Fiction/", "SciFi"));

      const cascades = await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({
        _tag: "FolderMetaSyncRequested",
        path: "/test/data/Fiction",
      });
    });

    test("returns empty cascades for top-level folder deletion", async () => {
      const effect = folderCleanup(folderDeletedEvent("/test/books/", "Fiction"));

      const cascades = await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(cascades).toHaveLength(0);
    });
  });
});
