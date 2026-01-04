import { Effect, Queue, Fiber } from "effect";
import { Schema } from "@effect/schema";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config } from "./config.ts";
import { createRouter } from "./routes/index.ts";
import { logger } from "./utils/errors.ts";
import { FileEvent } from "./effect/events.ts";
import { makeEventQueue, addEvent, getQueueSize, processEvents } from "./effect/queue.ts";
import { LiveLayer } from "./effect/services.ts";
import { scanFiles, createSyncPlan, computeHash } from "./scanner.ts";
import { generateAllFeeds } from "./feed-generator.ts";
import { bookSync } from "./effect/handlers/book-sync.ts";
import { bookCleanup } from "./effect/handlers/book-cleanup.ts";
import { folderSync } from "./effect/handlers/folder-sync.ts";

let currentHash = "";
let isRebuilding = false;
let bookCount = 0;
let folderCount = 0;

// Event queue (initialized on startup)
let eventQueue: Queue.Queue<FileEvent> | null = null;
let consumerFiber: Fiber.RuntimeFiber<void, Error> | null = null;

export function setServerState(state: {
	hash?: string;
	isRebuilding?: boolean;
	bookCount?: number;
	folderCount?: number;
}): void {
	if (state.hash !== undefined) currentHash = state.hash;
	if (state.isRebuilding !== undefined) isRebuilding = state.isRebuilding;
	if (state.bookCount !== undefined) bookCount = state.bookCount;
	if (state.folderCount !== undefined) folderCount = state.folderCount;
}

// Initial sync using Effect handlers
async function initialSync(): Promise<void> {
	logger.info("InitialSync", "Starting...");
	const startTime = Date.now();

	await mkdir(config.dataPath, { recursive: true });

	const files = await scanFiles(config.filesPath);
	logger.info("InitialSync", `Found ${files.length} books`);

	const plan = await createSyncPlan(files, config.dataPath);
	logger.info("InitialSync", `Plan: +${plan.toProcess.length} process, -${plan.toDelete.length} delete, ${plan.folders.length} folders`);

	// Delete orphans
	for (const path of plan.toDelete) {
		const parent = dirname(join(config.filesPath, path)) + "/";
		const name = path.split("/").pop() ?? "";
		await Effect.runPromise(Effect.provide(bookCleanup(parent, name), LiveLayer)).catch(() => {});
	}

	// Process folders
	for (const folder of plan.folders) {
		const parent = dirname(join(config.filesPath, folder.path)) + "/";
		const name = folder.path.split("/").pop() ?? "";
		await Effect.runPromise(Effect.provide(folderSync(parent, name), LiveLayer)).catch((e) => {
			logger.warn("InitialSync", `Failed folder: ${folder.path}`, { error: String(e) });
		});
	}

	// Process books
	for (const file of plan.toProcess) {
		const parent = dirname(join(config.filesPath, file.relativePath)) + "/";
		const name = file.relativePath.split("/").pop() ?? "";
		await Effect.runPromise(Effect.provide(bookSync(parent, name), LiveLayer)).catch((e) => {
			logger.warn("InitialSync", `Failed book: ${file.relativePath}`, { error: String(e) });
		});
	}

	// Generate feeds
	await generateAllFeeds(config.dataPath);

	currentHash = computeHash(files);
	bookCount = files.length;
	folderCount = plan.folders.length;

	const duration = Date.now() - startTime;
	logger.info("InitialSync", `Completed in ${duration}ms`, { books: bookCount, folders: folderCount });
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

// Run initialization and initial sync
async function startup(): Promise<void> {
	try {
		await Effect.runPromise(Effect.provide(initQueue, LiveLayer));
		await initialSync();
	} catch (error) {
		logger.error("Server", "Startup failed", error);
		process.exit(1);
	}
}

void startup();

const router = createRouter({
	getCurrentHash: () => currentHash,
	isRebuilding: () => isRebuilding,
	getBookCount: () => bookCount,
	getFolderCount: () => folderCount,
	triggerSync: () => {
		logger.warn("Server", "triggerSync not implemented in event-driven mode");
	},
});

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

		// GET /health — include queue stats
		if (url.pathname === "/health") {
			let queueSize = 0;
			if (eventQueue) {
				queueSize = await Effect.runPromise(getQueueSize(eventQueue));
			}

			return Response.json({
				status: eventQueue ? "ready" : "initializing",
				books: bookCount,
				folders: folderCount,
				hash: currentHash,
				queueSize,
			});
		}

		// All other routes go to the main router
		return router(req);
	},
});

logger.info("Server", `Listening on http://localhost:${server.port}`);

// Graceful shutdown
process.on("SIGTERM", async () => {
	logger.info("Server", "Shutting down...");
	if (consumerFiber) {
		await Effect.runPromise(Fiber.interrupt(consumerFiber));
	}
	process.exit(0);
});
