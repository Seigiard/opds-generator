import { Effect, Queue, Fiber } from "effect";
import { Schema } from "@effect/schema";
import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config } from "./config.ts";
import { createRouter } from "./routes/index.ts";
import { logger } from "./utils/errors.ts";
import {
	FileEvent,
	createBookCreatedEvent,
	createBookDeletedEvent,
	createFolderCreatedEvent,
} from "./effect/events.ts";
import { makeEventQueue, addEvent, getQueueSize, clearQueue, processEvents } from "./effect/queue.ts";
import { LiveLayer } from "./effect/services.ts";
import { scanFiles, createSyncPlan } from "./scanner.ts";

// Event queue (initialized on startup)
let eventQueue: Queue.Queue<FileEvent> | null = null;
let consumerFiber: Fiber.RuntimeFiber<void, Error> | null = null;
let isSyncing = false;

// Initial sync: sends events to queue instead of calling handlers directly
async function initialSync(queue: Queue.Queue<FileEvent>): Promise<void> {
	isSyncing = true;
	logger.info("InitialSync", "Starting...");
	const startTime = Date.now();

	await mkdir(config.dataPath, { recursive: true });

	const files = await scanFiles(config.filesPath);
	logger.info("InitialSync", `Found ${files.length} books`);

	const plan = await createSyncPlan(files, config.dataPath);
	logger.info("InitialSync", `Plan: +${plan.toProcess.length} process, -${plan.toDelete.length} delete, ${plan.folders.length} folders`);

	// Queue deletions
	for (const path of plan.toDelete) {
		const parent = dirname(join(config.filesPath, path)) + "/";
		const name = path.split("/").pop() ?? "";
		await Effect.runPromise(addEvent(queue)(createBookDeletedEvent(parent, name)));
	}

	// Queue folders
	for (const folder of plan.folders) {
		const parent = dirname(join(config.filesPath, folder.path)) + "/";
		const name = folder.path.split("/").pop() ?? "";
		await Effect.runPromise(addEvent(queue)(createFolderCreatedEvent(parent, name)));
	}

	// Queue books
	for (const file of plan.toProcess) {
		const parent = dirname(join(config.filesPath, file.relativePath)) + "/";
		const name = file.relativePath.split("/").pop() ?? "";
		await Effect.runPromise(addEvent(queue)(createBookCreatedEvent(parent, name)));
	}

	const duration = Date.now() - startTime;
	const totalEvents = plan.toDelete.length + plan.folders.length + plan.toProcess.length;
	logger.info("InitialSync", `Queued ${totalEvents} events in ${duration}ms`);
	isSyncing = false;
}

// Resync: clear queue, clear data, run initialSync
async function resync(queue: Queue.Queue<FileEvent>): Promise<void> {
	logger.info("Resync", "Starting full resync...");

	// Clear queue
	const cleared = await Effect.runPromise(clearQueue(queue));
	logger.info("Resync", `Cleared ${cleared} events from queue`);

	// Clear data directory
	await rm(config.dataPath, { recursive: true, force: true });
	await mkdir(config.dataPath, { recursive: true });
	logger.info("Resync", "Cleared data directory");

	// Run initial sync
	await initialSync(queue);
}

// Initialize queue and consumer
const initQueue = Effect.gen(function* () {
	const queue = yield* makeEventQueue;
	eventQueue = queue;

	// Start consumer in background
	const fiber = yield* Effect.fork(processEvents(queue));
	consumerFiber = fiber;

	logger.info("Server", "Event queue initialized");
	return queue;
});

// Create router (simplified - no metrics needed)
const router = createRouter();

// Start server immediately after queue init
async function main(): Promise<void> {
	try {
		// 1. Initialize queue first
		const queue = await Effect.runPromise(Effect.provide(initQueue, LiveLayer));

		// 2. Start HTTP server (watcher can now connect)
		const server = Bun.serve({
			port: config.port,
			async fetch(req) {
				const url = new URL(req.url);

				// POST /events — receive events from inotifywait
				if (req.method === "POST" && url.pathname === "/events") {
					if (!eventQueue) {
						return new Response("Queue not ready", { status: 503 });
					}

					try {
						const body = await req.json();

						// Validate event schema
						const parseResult = Schema.decodeUnknownEither(FileEvent)(body);
						if (parseResult._tag === "Left") {
							logger.warn("Server", "Invalid event schema", { body });
							return new Response("Invalid event", { status: 400 });
						}

						const event = parseResult.right;

						// Add to queue
						await Effect.runPromise(addEvent(eventQueue)(event));
						return new Response("OK", { status: 202 });
					} catch (error) {
						logger.error("Server", "Failed to process event", error);
						return new Response("Error", { status: 500 });
					}
				}

				// POST /resync — full resync
				if (req.method === "POST" && url.pathname === "/resync") {
					if (!eventQueue) {
						return new Response("Queue not ready", { status: 503 });
					}

					if (isSyncing) {
						return new Response("Sync already in progress", { status: 409 });
					}

					void resync(eventQueue);
					return new Response("Resync started", { status: 202 });
				}

				// GET /health — queue stats only
				if (url.pathname === "/health") {
					let queueSize = 0;
					if (eventQueue) {
						queueSize = await Effect.runPromise(getQueueSize(eventQueue));
					}

					return Response.json({
						status: eventQueue ? "ready" : "initializing",
						queueSize,
						syncing: isSyncing,
					});
				}

				// All other routes go to the main router
				return router(req);
			},
		});

		logger.info("Server", `Listening on http://localhost:${server.port}`);

		// 3. Run initial sync (sends events to queue)
		await initialSync(queue);
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
