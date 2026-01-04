import { describe, test, expect, beforeEach } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../src/effect/services.ts";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import { folderCleanup } from "../../../src/effect/handlers/folder-cleanup.ts";
import { bookCleanup } from "../../../src/effect/handlers/book-cleanup.ts";
import type { EventType } from "../../../src/effect/types.ts";

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

const TestConfigService = Layer.succeed(ConfigService, {
	filesPath: "/test/books",
	dataPath: "/test/data",
	baseUrl: "http://test.local",
	port: 8080,
});

const TestLoggerService = Layer.succeed(LoggerService, {
	info: (tag, msg) =>
		Effect.sync(() => {
			mockLogger.infoCalls.push({ tag, msg });
		}),
	warn: () => Effect.void,
	error: () => Effect.void,
	debug: () => Effect.void,
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
	readdir: () => Effect.succeed([]),
	stat: () => Effect.succeed({ isDirectory: () => false, size: 0 }),
	exists: () => Effect.succeed(false),
	writeFile: (path, content) =>
		Effect.sync(() => {
			mockFs.writeCalls.push({ path, content });
		}),
	atomicWrite: (path, content) =>
		Effect.sync(() => {
			mockFs.writeCalls.push({ path, content });
		}),
	symlink: () => Effect.void,
	unlink: () => Effect.void,
});

const TestLayer = Layer.mergeAll(TestConfigService, TestLoggerService, TestFileSystemService);

// Helper to create events
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

describe("Initial Sync - Folder and Cleanup Handlers", () => {
	beforeEach(() => {
		mockFs.reset();
		mockLogger.reset();
	});

	describe("folderSync during initial sync", () => {
		test("creates folder data directory", async () => {
			await Effect.runPromise(Effect.provide(folderSync(folderCreatedEvent("/test/books/", "Fiction")), TestLayer));
			expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction")).toBe(true);
		});

		test("generates _entry.xml for folder", async () => {
			await Effect.runPromise(Effect.provide(folderSync(folderCreatedEvent("/test/books/", "Fiction")), TestLayer));
			const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
			expect(entryWrite).toBeDefined();
			expect(entryWrite?.content).toContain("<entry");
		});

		test("processes nested folder paths correctly", async () => {
			await Effect.runPromise(Effect.provide(folderSync(folderCreatedEvent("/test/books/Fiction/", "SciFi")), TestLayer));
			expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction/SciFi")).toBe(true);
		});
	});

	describe("folderCleanup during initial sync", () => {
		test("removes orphan folder directory", async () => {
			await Effect.runPromise(Effect.provide(folderCleanup(folderDeletedEvent("/test/books/", "OldFolder")), TestLayer));
			expect(mockFs.rmCalls).toHaveLength(1);
			expect(mockFs.rmCalls[0]!.path).toBe("/test/data/OldFolder");
		});
	});

	describe("bookCleanup during initial sync", () => {
		test("removes orphan book directory", async () => {
			await Effect.runPromise(
				Effect.provide(bookCleanup(bookDeletedEvent("/test/books/Fiction/", "deleted.epub")), TestLayer),
			);
			expect(mockFs.rmCalls).toHaveLength(1);
			expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/deleted.epub");
		});
	});

	describe("sync flow simulation", () => {
		test("processes multiple folders sequentially", async () => {
			const folders = ["Fiction", "NonFiction", "Comics"];
			for (const folder of folders) {
				await Effect.runPromise(Effect.provide(folderSync(folderCreatedEvent("/test/books/", folder)), TestLayer));
			}
			const entryWrites = mockFs.writeCalls.filter((c) => c.path.endsWith("_entry.xml"));
			expect(entryWrites).toHaveLength(3);
		});

		test("cleanup then create for folder replacement", async () => {
			await Effect.runPromise(
				Effect.provide(folderCleanup(folderDeletedEvent("/test/books/", "OldFolder")), TestLayer),
			);
			await Effect.runPromise(Effect.provide(folderSync(folderCreatedEvent("/test/books/", "NewFolder")), TestLayer));

			expect(mockFs.rmCalls.some((c) => c.path.includes("OldFolder"))).toBe(true);
			expect(mockFs.mkdirCalls.some((c) => c.path.includes("NewFolder"))).toBe(true);
		});

		test("logs operations for each handler", async () => {
			await Effect.runPromise(Effect.provide(folderSync(folderCreatedEvent("/test/books/", "Fiction")), TestLayer));
			await Effect.runPromise(
				Effect.provide(bookCleanup(bookDeletedEvent("/test/books/Fiction/", "old.epub")), TestLayer),
			);

			expect(mockLogger.infoCalls.some((c) => c.tag === "FolderSync")).toBe(true);
			expect(mockLogger.infoCalls.some((c) => c.tag === "BookCleanup")).toBe(true);
		});
	});
});
