import { Effect, Queue, Fiber } from "effect";
import { Schema } from "@effect/schema";
import { config } from "./config.ts";
import { createRouter } from "./routes/index.ts";
import { logger } from "./utils/errors.ts";
import { FileEvent } from "./effect/events.ts";
import { makeEventQueue, addEvent, getQueueSize, processEvents } from "./effect/queue.ts";
import { LiveLayer } from "./effect/services.ts";

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

// Run initialization
Effect.runPromise(Effect.provide(initQueue, LiveLayer)).catch((error) => {
	logger.error("Server", "Failed to initialize queue", error);
	process.exit(1);
});

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
