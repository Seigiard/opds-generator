import { Effect, Fiber } from "effect";
import { Schema } from "@effect/schema";
import { mkdir, rm } from "node:fs/promises";
import { config } from "./config.ts";
import { createRouter } from "./routes/index.ts";
import { logger } from "./utils/errors.ts";
import { RawWatcherEvent } from "./effect/types.ts";
import { adaptWatcherEvent, adaptSyncPlan } from "./effect/adapters/event-adapter.ts";
import { startConsumer } from "./effect/consumer.ts";
import { registerHandlers } from "./effect/handlers/index.ts";
import { ErrorLogService, EventQueueService, LiveLayer } from "./effect/services.ts";
import { scanFiles, createSyncPlan } from "./scanner.ts";

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

// Resync: clear data and error log, run sync (manages own flag)
const resync = Effect.gen(function* () {
  isSyncing = true;
  logger.info("Resync", "Starting full resync...");

  // Clear error log
  const errorLog = yield* ErrorLogService;
  yield* errorLog.clear();

  // Clear data directory
  yield* Effect.tryPromise({
    try: () => rm(config.dataPath, { recursive: true, force: true }),
    catch: (e) => e as Error,
  });
  yield* Effect.tryPromise({
    try: () => mkdir(config.dataPath, { recursive: true }),
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

// Handle incoming watcher event
const handleWatcherEvent = (body: unknown) =>
  Effect.gen(function* () {
    const queue = yield* EventQueueService;

    // Validate event schema
    const parseResult = Schema.decodeUnknownEither(RawWatcherEvent)(body);
    if (parseResult._tag === "Left") {
      logger.warn("Server", "Invalid event schema", { body });
      return { status: 400, message: "Invalid event" };
    }

    const raw = parseResult.right;

    // Adapt to typed event (with deduplication)
    const event = yield* adaptWatcherEvent(raw);
    if (event === null) {
      return { status: 202, message: "Deduplicated" };
    }

    // Enqueue
    yield* queue.enqueue(event);
    return { status: 202, message: "OK" };
  });

// Get health status
const getHealthStatus = Effect.gen(function* () {
  const queue = yield* EventQueueService;
  const queueSize = yield* queue.size();

  return {
    status: isReady ? "ready" : "initializing",
    queueSize,
    syncing: isSyncing,
  };
});

// Initialize and start server
const initServer = Effect.gen(function* () {
  // 1. Register all handlers in registry
  yield* registerHandlers;
  logger.info("Server", "Handlers registered");

  // 2. Start consumer in background
  const fiber = yield* Effect.fork(startConsumer);
  consumerFiber = fiber;
  logger.info("Server", "Consumer started");

  isReady = true;
});

// Create router
const router = createRouter();

// Main entry point
async function main(): Promise<void> {
  try {
    // 1. Initialize server (handlers + consumer)
    await Effect.runPromise(Effect.provide(initServer, LiveLayer));

    // 2. Start HTTP server
    const server = Bun.serve({
      port: config.port,
      async fetch(req) {
        const url = new URL(req.url);

        // POST /events — receive events from inotifywait
        if (req.method === "POST" && url.pathname === "/events") {
          if (!isReady) {
            return new Response("Queue not ready", { status: 503 });
          }

          try {
            const body = await req.json();
            const result = await Effect.runPromise(Effect.provide(handleWatcherEvent(body), LiveLayer));
            return new Response(result.message, { status: result.status });
          } catch (error) {
            logger.error("Server", "Failed to process event", error);
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

          Effect.runPromise(Effect.provide(resync, LiveLayer)).catch((error) => {
            logger.error("Server", "Resync failed", error);
          });
          return new Response("Resync started", { status: 202 });
        }

        // GET /health — queue stats
        if (url.pathname === "/health") {
          const health = await Effect.runPromise(Effect.provide(getHealthStatus, LiveLayer));
          return Response.json(health);
        }

        // All other routes go to the main router
        return router(req);
      },
    });

    logger.info("Server", `Listening on http://localhost:${server.port}`);

    // 3. Run initial sync
    await Effect.runPromise(Effect.provide(initialSync, LiveLayer));
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
    await Effect.runPromise(Fiber.interrupt(consumerFiber));
  }
  process.exit(0);
});
