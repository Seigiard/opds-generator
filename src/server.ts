import { Effect, Fiber, ManagedRuntime } from "effect";
import { Schema } from "@effect/schema";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { logger } from "./utils/errors.ts";
import { RawBooksEvent, RawDataEvent } from "./effect/types.ts";
import { adaptBooksEvent } from "./effect/adapters/books-adapter.ts";
import { adaptDataEvent } from "./effect/adapters/data-adapter.ts";
import { adaptSyncPlan } from "./effect/adapters/sync-plan-adapter.ts";
import { startConsumer } from "./effect/consumer.ts";
import { registerHandlers } from "./effect/handlers/index.ts";
import { ErrorLogService, EventLogService, EventQueueService, LiveLayer } from "./effect/services.ts";
import { scanFiles, createSyncPlan } from "./scanner.ts";

// Shared runtime - single instance of all services
const runtime = ManagedRuntime.make(LiveLayer);

// Runtime state
let isReady = false;
let isSyncing = false;
let consumerFiber: Fiber.RuntimeFiber<never, Error> | null = null;

// Internal sync logic (no flag management)
const doSync = Effect.gen(function* () {
  const queue = yield* EventQueueService;

  logger.info("InitialSync", "Starting...");
  const startTime = Date.now();

  yield* Effect.tryPromise({
    try: () => mkdir(config.dataPath, { recursive: true }),
    catch: (e) => e as Error,
  });

  const files = yield* Effect.tryPromise({
    try: () => scanFiles(config.filesPath),
    catch: (e) => e as Error,
  });
  logger.info("InitialSync", `Found ${files.length} books`);

  const plan = yield* Effect.tryPromise({
    try: () => createSyncPlan(files, config.dataPath),
    catch: (e) => e as Error,
  });
  logger.info("InitialSync", `Plan: +${plan.toProcess.length} process, -${plan.toDelete.length} delete, ${plan.folders.length} folders`);

  // Convert sync plan to events
  const events = adaptSyncPlan(plan, config.filesPath);

  // Enqueue all events
  yield* queue.enqueueMany(events);

  const duration = Date.now() - startTime;
  logger.info("InitialSync", `Queued ${events.length} events in ${duration}ms`);
});

// Initial sync: manages isSyncing flag with guaranteed cleanup
const initialSync = Effect.gen(function* () {
  isSyncing = true;
  yield* doSync;
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      isSyncing = false;
    }),
  ),
);

// Resync: clear data and error/event logs, run sync (manages own flag)
const resync = Effect.gen(function* () {
  isSyncing = true;
  logger.info("Resync", "Starting full resync...");

  // Clear error log
  const errorLog = yield* ErrorLogService;
  yield* errorLog.clear();

  // Clear event log
  const eventLog = yield* EventLogService;
  yield* eventLog.clear();

  // Clear data directory contents (not the directory itself - nginx holds it open)
  yield* Effect.tryPromise({
    try: async () => {
      const entries = await readdir(config.dataPath);
      await Promise.all(entries.map((entry) => rm(join(config.dataPath, entry), { recursive: true, force: true })));
    },
    catch: (e) => e as Error,
  });
  logger.info("Resync", "Cleared data directory");

  // Run sync logic (doSync, not initialSync to avoid double flag management)
  yield* doSync;
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      isSyncing = false;
    }),
  ),
);

// Handle incoming books watcher event
const handleBooksEvent = (body: unknown) =>
  Effect.gen(function* () {
    const queue = yield* EventQueueService;

    const parseResult = Schema.decodeUnknownEither(RawBooksEvent)(body);
    if (parseResult._tag === "Left") {
      logger.warn("Server", "Invalid books event schema", { body });
      return { status: 400, message: "Invalid event" };
    }

    const raw = parseResult.right;
    const event = yield* adaptBooksEvent(raw);
    if (event === null) {
      return { status: 202, message: "Deduplicated" };
    }

    yield* queue.enqueue(event);
    return { status: 202, message: "OK" };
  });

// Handle incoming data watcher event
const handleDataEvent = (body: unknown) =>
  Effect.gen(function* () {
    const queue = yield* EventQueueService;

    const parseResult = Schema.decodeUnknownEither(RawDataEvent)(body);
    if (parseResult._tag === "Left") {
      logger.warn("Server", "Invalid data event schema", { body });
      return { status: 400, message: "Invalid event" };
    }

    const raw = parseResult.right;
    const event = yield* adaptDataEvent(raw);
    if (event === null) {
      return { status: 202, message: "Deduplicated" };
    }

    yield* queue.enqueue(event);
    return { status: 202, message: "OK" };
  });

// Initialize handlers only
const initHandlers = Effect.gen(function* () {
  yield* registerHandlers;
  logger.info("Server", "Handlers registered");
});

// Clear event log on startup (don't persist between restarts)
const clearEventLogOnStartup = Effect.gen(function* () {
  const eventLog = yield* EventLogService;
  yield* eventLog.clear();
  logger.info("Server", "Event log cleared");
});

// Main entry point
async function main(): Promise<void> {
  try {
    // 1. Register handlers
    await runtime.runPromise(initHandlers);

    // 2. Clear event log (don't persist between restarts)
    await runtime.runPromise(clearEventLogOnStartup);

    // 3. Start consumer in background (using runFork for proper fiber execution)
    consumerFiber = runtime.runFork(startConsumer);
    logger.info("Server", "Consumer started");
    isReady = true;

    // 4. Start HTTP server
    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);

        // POST /events/books — receive events from books watcher
        if (req.method === "POST" && url.pathname === "/events/books") {
          if (!isReady) {
            return new Response("Queue not ready", { status: 503 });
          }

          try {
            const body = await req.json();
            const result = await runtime.runPromise(handleBooksEvent(body));
            return new Response(result.message, { status: result.status });
          } catch (error) {
            logger.error("Server", "Failed to process books event", error);
            return new Response("Error", { status: 500 });
          }
        }

        // POST /events/data — receive events from data watcher
        if (req.method === "POST" && url.pathname === "/events/data") {
          if (!isReady) {
            return new Response("Queue not ready", { status: 503 });
          }

          try {
            const body = await req.json();
            const result = await runtime.runPromise(handleDataEvent(body));
            return new Response(result.message, { status: result.status });
          } catch (error) {
            logger.error("Server", "Failed to process data event", error);
            return new Response("Error", { status: 500 });
          }
        }

        // POST /resync — full resync
        if (req.method === "POST" && url.pathname === "/resync") {
          if (!isReady) {
            return new Response("Queue not ready", { status: 503 });
          }

          if (isSyncing) {
            return new Response("Sync already in progress", { status: 409 });
          }

          runtime.runPromise(resync).catch((error) => {
            logger.error("Server", "Resync failed", error);
          });
          return new Response("Resync started", { status: 202 });
        }

        // All other routes are handled by nginx
        return new Response("Not found", { status: 404 });
      },
    });

    logger.info("Server", `Listening on http://localhost:${server.port}`);

    // 5. Run initial sync
    await runtime.runPromise(initialSync);
  } catch (error) {
    logger.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

void main();

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("Server", "Shutting down...");
  if (consumerFiber) {
    await runtime.runPromise(Fiber.interrupt(consumerFiber));
  }
  await runtime.dispose();
  process.exit(0);
});
