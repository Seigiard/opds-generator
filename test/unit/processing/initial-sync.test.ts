import { describe, test, expect, beforeEach } from "bun:test";
import { type EffectHandler } from "../../../src/processing/effect-handler.ts";
import { runAsPromiseHandler } from "../../helpers/effect-test-handlers.ts";
import { folderSyncEffect } from "../../../src/processing/handlers/folder-sync-effect.ts";
import { folderCleanupEffect } from "../../../src/processing/handlers/folder-cleanup-effect.ts";
import { bookCleanupEffect } from "../../../src/processing/handlers/book-cleanup-effect.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/processing/types.ts";

interface MockFs {
  mkdirCalls: Array<{ path: string; options?: { recursive?: boolean } }>;
  rmCalls: Array<{ path: string; options?: { recursive?: boolean } }>;
  writeCalls: Array<{ path: string; content: string }>;
  reset: () => void;
}

interface MockLogger {
  infoCalls: Array<{ tag: string; msg: string }>;
  reset: () => void;
}

const createMockFs = (): MockFs => ({
  mkdirCalls: [],
  rmCalls: [],
  writeCalls: [],
  reset() {
    this.mkdirCalls = [];
    this.rmCalls = [];
    this.writeCalls = [];
  },
});

const createMockLogger = (): MockLogger => ({
  infoCalls: [],
  reset() {
    this.infoCalls = [];
  },
});

const mockFs = createMockFs();

const mockLogger = createMockLogger();

const asyncDeps: HandlerDeps = {
  config: { filesPath: "/test/books", dataPath: "/test/data", port: 8080, reconcileInterval: 1800 },
  logger: {
    info: (tag, msg) => mockLogger.infoCalls.push({ tag, msg }),
    warn: () => {},
    error: () => {},
    debug: () => {},
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
    symlink: async () => {},
    unlink: async () => {},
  },
};

const folderCreatedEvent = (parent: string, name: string): EventType => ({
  _tag: "FolderCreated",
  parent,
  name,
});

const folderDeletedEvent = (parent: string, name: string): EventType => ({
  _tag: "FolderDeleted",
  parent,
  name,
});

const bookDeletedEvent = (parent: string, name: string): EventType => ({
  _tag: "BookDeleted",
  parent,
  name,
});

const runHandler = (handler: EffectHandler, event: EventType) => runAsPromiseHandler(handler, event, asyncDeps);

const folderSync = (event: EventType) => runHandler(folderSyncEffect, event);

const folderCleanup = (event: EventType) => runHandler(folderCleanupEffect, event);

const bookCleanup = (event: EventType) => runHandler(bookCleanupEffect, event);

describe("Initial Sync - Folder and Cleanup Handlers", () => {
  beforeEach(() => {
    mockFs.reset();
    mockLogger.reset();
  });

  describe("folderSync during initial sync", () => {
    test("creates folder data directory", async () => {
      await folderSync(folderCreatedEvent("/test/books/", "Fiction"));
      expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction")).toBe(true);
    });

    test("generates _entry.xml for folder", async () => {
      await folderSync(folderCreatedEvent("/test/books/", "Fiction"));
      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite).toBeDefined();
      expect(entryWrite?.content).toContain("<entry");
    });

    test("processes nested folder paths correctly", async () => {
      await folderSync(folderCreatedEvent("/test/books/Fiction/", "SciFi"));
      expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction/SciFi")).toBe(true);
    });
  });

  describe("folderCleanup during initial sync", () => {
    test("removes orphan folder directory", async () => {
      await folderCleanup(folderDeletedEvent("/test/books/", "OldFolder"));
      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/OldFolder");
    });
  });

  describe("bookCleanup during initial sync", () => {
    test("removes orphan book directory", async () => {
      await bookCleanup(bookDeletedEvent("/test/books/Fiction/", "deleted.epub"));
      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/deleted.epub");
    });
  });

  describe("sync flow simulation", () => {
    test("processes multiple folders sequentially", async () => {
      const folders = ["Fiction", "NonFiction", "Comics"];

      for (const folder of folders) {
        await folderSync(folderCreatedEvent("/test/books/", folder));
      }

      const entryWrites = mockFs.writeCalls.filter((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrites).toHaveLength(3);
    });

    test("cleanup then create for folder replacement", async () => {
      await folderCleanup(folderDeletedEvent("/test/books/", "OldFolder"));
      await folderSync(folderCreatedEvent("/test/books/", "NewFolder"));

      expect(mockFs.rmCalls.some((c) => c.path.includes("OldFolder"))).toBe(true);
      expect(mockFs.mkdirCalls.some((c) => c.path.includes("NewFolder"))).toBe(true);
    });
  });
});
