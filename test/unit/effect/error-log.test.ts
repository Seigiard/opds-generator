import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect, Layer } from "effect";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorLogService, type ErrorLogEntry } from "../../../src/effect/services.ts";

describe("ErrorLogService", () => {
  let testDir: string;
  let errorLogPath: string;

  // Create a test-specific ErrorLogService with a temp directory
  const createTestErrorLogService = () =>
    Layer.succeed(ErrorLogService, {
      log: (entry: ErrorLogEntry) =>
        Effect.promise(async () => {
          const line = JSON.stringify(entry) + "\n";
          const file = Bun.file(errorLogPath);
          const existing = (await file.exists()) ? await file.text() : "";
          await Bun.write(errorLogPath, existing + line);
        }).pipe(Effect.catchAll(() => Effect.void)),

      clear: () =>
        Effect.promise(async () => {
          await Bun.write(errorLogPath, "");
        }).pipe(Effect.catchAll(() => Effect.void)),
    });

  beforeEach(async () => {
    testDir = join(tmpdir(), `error-log-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    errorLogPath = join(testDir, "errors.jsonl");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("logs error entry as JSONL", async () => {
    const TestLayer = createTestErrorLogService();

    const entry: ErrorLogEntry = {
      timestamp: "2025-01-04T12:00:00.000Z",
      event_tag: "BookCreated",
      path: "/files/Fiction/book.epub",
      error: "Failed to extract metadata",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const errorLog = yield* ErrorLogService;
        yield* errorLog.log(entry);
      }).pipe(Effect.provide(TestLayer)),
    );

    const content = await Bun.file(errorLogPath).text();
    const parsed = JSON.parse(content.trim());

    expect(parsed.timestamp).toBe("2025-01-04T12:00:00.000Z");
    expect(parsed.event_tag).toBe("BookCreated");
    expect(parsed.path).toBe("/files/Fiction/book.epub");
    expect(parsed.error).toBe("Failed to extract metadata");
  });

  test("appends multiple entries", async () => {
    const TestLayer = createTestErrorLogService();

    const entry1: ErrorLogEntry = {
      timestamp: "2025-01-04T12:00:00.000Z",
      event_tag: "BookCreated",
      error: "Error 1",
    };

    const entry2: ErrorLogEntry = {
      timestamp: "2025-01-04T12:01:00.000Z",
      event_tag: "FolderCreated",
      error: "Error 2",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const errorLog = yield* ErrorLogService;
        yield* errorLog.log(entry1);
        yield* errorLog.log(entry2);
      }).pipe(Effect.provide(TestLayer)),
    );

    const content = await Bun.file(errorLogPath).text();
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).error).toBe("Error 1");
    expect(JSON.parse(lines[1]!).error).toBe("Error 2");
  });

  test("clears the log file", async () => {
    const TestLayer = createTestErrorLogService();

    const entry: ErrorLogEntry = {
      timestamp: "2025-01-04T12:00:00.000Z",
      event_tag: "BookCreated",
      error: "Error",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const errorLog = yield* ErrorLogService;
        yield* errorLog.log(entry);
        yield* errorLog.clear();
      }).pipe(Effect.provide(TestLayer)),
    );

    const content = await Bun.file(errorLogPath).text();
    expect(content).toBe("");
  });

  test("includes stack trace when provided", async () => {
    const TestLayer = createTestErrorLogService();

    const entry: ErrorLogEntry = {
      timestamp: "2025-01-04T12:00:00.000Z",
      event_tag: "BookCreated",
      error: "Error",
      stack: "Error: Something\n    at test.ts:1:1",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const errorLog = yield* ErrorLogService;
        yield* errorLog.log(entry);
      }).pipe(Effect.provide(TestLayer)),
    );

    const content = await Bun.file(errorLogPath).text();
    const parsed = JSON.parse(content.trim());

    expect(parsed.stack).toContain("Error: Something");
  });
});
