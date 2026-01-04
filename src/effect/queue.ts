import { Effect, Queue, Option } from "effect";
import type { FileEvent } from "./events.ts";
import { classifyEvent } from "./events.ts";
import { handleEvent } from "./router.ts";
import { LoggerService } from "./services.ts";

export const makeEventQueue = Effect.gen(function* () {
	return yield* Queue.unbounded<FileEvent>();
});

export const addEvent =
	(queue: Queue.Queue<FileEvent>) =>
	(event: FileEvent): Effect.Effect<void> =>
		Queue.offer(queue, event);

export const getQueueSize = (queue: Queue.Queue<FileEvent>): Effect.Effect<number> =>
	Queue.size(queue);

export const clearQueue = (queue: Queue.Queue<FileEvent>) =>
	Effect.gen(function* () {
		let cleared = 0;
		while (true) {
			const item = yield* Queue.poll(queue);
			if (Option.isNone(item)) break;
			cleared++;
		}
		return cleared;
	});

export const processEvents = (queue: Queue.Queue<FileEvent>) =>
	Effect.gen(function* () {
		const logger = yield* LoggerService;

		yield* logger.info("QueueConsumer", "Started processing events");

		while (true) {
			const event = yield* Queue.take(queue);
			const eventType = classifyEvent(event);

			if (eventType._tag === "Ignored") {
				yield* logger.debug("QueueConsumer", `Ignored: ${event.name}`, { events: event.events });
				continue;
			}

			yield* logger.info("QueueConsumer", `Processing: ${eventType._tag}`, {
				parent: "parent" in eventType ? eventType.parent : undefined,
				name: "name" in eventType ? eventType.name : undefined,
			});

			// Handle event with error recovery (log and continue)
			yield* handleEvent(eventType).pipe(
				Effect.catchAll((error) =>
					logger.error("QueueConsumer", `Handler failed for ${eventType._tag}`, error),
				),
			);
		}
	});
