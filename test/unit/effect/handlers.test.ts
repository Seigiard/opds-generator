import { describe, test, expect, beforeEach } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../src/effect/services.ts";
import { folderCleanup } from "../../../src/effect/handlers/folder-cleanup.ts";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import { bookCleanup } from "../../../src/effect/handlers/book-cleanup.ts";

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
	infoCalls: Array<{ tag: string; msg: string; meta?: Record<string, unknown> }>;
	warnCalls: Array<{ tag: string; msg: string; meta?: Record<string, unknown> }>;
	errorCalls: Array<{ tag: string; msg: string; error?: unknown }>;
	debugCalls: Array<{ tag: string; msg: string; meta?: Record<string, unknown> }>;
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
	baseUrl: "http://test.local",
	port: 8080,
});

const TestLoggerService = Layer.succeed(LoggerService, {
	info: (tag, msg, meta) =>
		Effect.sync(() => {
			mockLogger.infoCalls.push({ tag, msg, meta });
		}),
	warn: (tag, msg, meta) =>
		Effect.sync(() => {
			mockLogger.warnCalls.push({ tag, msg, meta });
		}),
	error: (tag, msg, error) =>
		Effect.sync(() => {
			mockLogger.errorCalls.push({ tag, msg, error });
		}),
	debug: (tag, msg, meta) =>
		Effect.sync(() => {
			mockLogger.debugCalls.push({ tag, msg, meta });
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

describe("Effect Handlers", () => {
	beforeEach(() => {
		mockFs.reset();
		mockLogger.reset();
	});

	describe("folderCleanup", () => {
		test("removes data directory for deleted folder", async () => {
			const effect = folderCleanup("/test/books/Fiction", "Author");

			await Effect.runPromise(Effect.provide(effect, TestLayer));

			expect(mockFs.rmCalls).toHaveLength(1);
			expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/Author");
			expect(mockFs.rmCalls[0]!.options?.recursive).toBe(true);
		});

		test("logs the folder being removed", async () => {
			const effect = folderCleanup("/test/books/Fiction", "Author");

			await Effect.runPromise(Effect.provide(effect, TestLayer));

			expect(mockLogger.infoCalls.some((c) => c.tag === "FolderCleanup" && c.msg.includes("Removing"))).toBe(true);
		});

		test("handles nested folder paths correctly", async () => {
			const effect = folderCleanup("/test/books/Fiction/SciFi", "Isaac Asimov");

			await Effect.runPromise(Effect.provide(effect, TestLayer));

			expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/SciFi/Isaac Asimov");
		});
	});

	describe("folderSync", () => {
		test("creates data directory for new folder", async () => {
			const effect = folderSync("/test/books", "Fiction");

			await Effect.runPromise(Effect.provide(effect, TestLayer));

			expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction")).toBe(true);
		});

		test("creates _entry.xml for non-root folders", async () => {
			const effect = folderSync("/test/books", "Fiction");

			await Effect.runPromise(Effect.provide(effect, TestLayer));

			const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
			expect(entryWrite).toBeDefined();
			expect(entryWrite?.content).toContain("<entry");
		});

		test("does not create _entry.xml for root folder", async () => {
			const effect = folderSync("/test/books", "");

			await Effect.runPromise(Effect.provide(effect, TestLayer));

			const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
			expect(entryWrite).toBeUndefined();
		});

		test("includes subsection link in _entry.xml", async () => {
			const effect = folderSync("/test/books", "Fiction");

			await Effect.runPromise(Effect.provide(effect, TestLayer));

			const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
			expect(entryWrite?.content).toContain("Fiction/feed.xml");
		});
	});

	describe("bookCleanup", () => {
		test("removes data directory for deleted book", async () => {
			const effect = bookCleanup("/test/books/Fiction", "book.epub");

			await Effect.runPromise(Effect.provide(effect, TestLayer));

			expect(mockFs.rmCalls).toHaveLength(1);
			expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/book.epub");
			expect(mockFs.rmCalls[0]!.options?.recursive).toBe(true);
		});

		test("logs the book being removed", async () => {
			const effect = bookCleanup("/test/books/Fiction", "book.epub");

			await Effect.runPromise(Effect.provide(effect, TestLayer));

			expect(mockLogger.infoCalls.some((c) => c.tag === "BookCleanup" && c.msg.includes("Removing"))).toBe(true);
		});
	});
});
