import { Effect } from "effect";
import type { EventType } from "./types.ts";
import { EventQueueService, HandlerRegistry, LoggerService } from "./services.ts";

// Process a single event using handler from registry
export const processEvent = (event: EventType) =>
	Effect.gen(function* () {
		const queue = yield* EventQueueService;
		const registry = yield* HandlerRegistry;
		const logger = yield* LoggerService;

		// Get handler from registry
		const handler = registry.get(event._tag);
		if (!handler) {
			yield* logger.warn("Consumer", `No handler for ${event._tag}`);
			return;
		}

		// Process event, get cascading events
		const result = yield* handler(event).pipe(
			Effect.map((cascades) => ({ ok: true as const, cascades })),
			Effect.catchAll((error) =>
				logger.error("Consumer", `Handler failed for ${event._tag}`, error).pipe(
					Effect.map(() => ({ ok: false as const, cascades: [] as readonly EventType[] })),
				),
			),
		);

		// Cascading events go to end of queue (FIFO)
		if (result.ok && result.cascades.length > 0) {
			yield* queue.enqueueMany(result.cascades);
		}
	});

// Event loop - runs forever, processing events from queue
export const startConsumer = Effect.gen(function* () {
	const queue = yield* EventQueueService;
	const logger = yield* LoggerService;

	yield* logger.info("Consumer", "Started processing events");

	while (true) {
		const event = yield* queue.take();
		yield* processEvent(event);
	}
});
