import { BOOK_EXTENSIONS } from "../types.ts";
import { logger } from "../utils/errors.ts";

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 5000;

type WatcherType = "books" | "data";

interface EventInfo {
	parent: string;
	name: string;
	events: string;
}

const watcherType = Bun.argv[2] as WatcherType;
if (!watcherType || !["books", "data"].includes(watcherType)) {
	logger.error("Debouncer", "Usage: bun debouncer.ts <books|data>");
	process.exit(1);
}

const pending = new Map<string, EventInfo>();
let debounceTimer: Timer | null = null;
let maxWaitTimer: Timer | null = null;

function getHandler(event: EventInfo): string | null {
	if (watcherType === "data") {
		if (event.name === "entry.xml") {
			return "src/event/parent-meta-sync.ts";
		}
		if (event.name === "_entry.xml") {
			return "src/event/folder-meta-sync.ts";
		}
		return null;
	}

	const isDir = event.events.includes("ISDIR");
	const isDelete = event.events.includes("DELETE") || event.events.includes("MOVED_FROM");
	const isCreate =
		event.events.includes("CREATE") ||
		event.events.includes("CLOSE_WRITE") ||
		event.events.includes("MOVED_TO");

	if (isDir) {
		if (isDelete) return "src/event/folder-cleanup.ts";
		if (isCreate) return "src/event/folder-sync.ts";
		return null;
	}

	const ext = event.name.split(".").pop()?.toLowerCase() ?? "";
	if (!BOOK_EXTENSIONS.includes(ext)) {
		return null;
	}

	if (isDelete) return "src/event/book-cleanup.ts";
	if (isCreate) return "src/event/book-sync.ts";
	return null;
}

async function flush(): Promise<void> {
	if (debounceTimer) clearTimeout(debounceTimer);
	if (maxWaitTimer) clearTimeout(maxWaitTimer);
	debounceTimer = null;
	maxWaitTimer = null;

	const batch = [...pending.values()];
	pending.clear();

	if (batch.length === 0) return;

	logger.debug("Debouncer", `Flushing ${batch.length} events`, { watcher: watcherType });

	for (const event of batch) {
		const handler = getHandler(event);
		if (!handler) {
			logger.debug("Debouncer", `Skipping event: ${event.name}`, { events: event.events });
			continue;
		}

		logger.info("Debouncer", `Running ${handler}`, {
			parent: event.parent,
			name: event.name,
		});

		try {
			const result =
				await Bun.$`bun run ${handler} ${event.parent} ${event.name} ${event.events}`.quiet();
			if (result.exitCode !== 0) {
				logger.error("Debouncer", `Handler failed: ${handler}`, result.stderr.toString());
			}
		} catch (error) {
			logger.error("Debouncer", `Handler error: ${handler}`, error);
		}

		// For _entry.xml: folder-meta-sync already regenerates feed.xml for this folder.
		// parent-meta-sync would regenerate the PARENT's feed.xml.
		// This is needed so parent folder includes updated child info.
		if (watcherType === "data" && event.name === "_entry.xml") {
			logger.info("Debouncer", "Also running parent-meta-sync for _entry.xml");
			try {
				await Bun.$`bun run src/event/parent-meta-sync.ts ${event.parent} ${event.name} ${event.events}`.quiet();
			} catch (error) {
				logger.error("Debouncer", "Parent-meta-sync error", error);
			}
		}
	}
}

function scheduleFlush(): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => void flush(), DEBOUNCE_MS);

	if (!maxWaitTimer) {
		maxWaitTimer = setTimeout(() => void flush(), MAX_WAIT_MS);
	}
}

function parseLine(line: string): EventInfo | null {
	const parts = line.trim().split("|");
	if (parts.length < 3) return null;
	const [parent, name, events] = parts;
	if (!parent || !name || !events) return null;
	return { parent, name, events };
}

logger.info("Debouncer", `Started for ${watcherType} watcher`);

const decoder = new TextDecoder();

for await (const chunk of Bun.stdin.stream()) {
	const text = decoder.decode(chunk);
	const lines = text.split("\n").filter((l) => l.trim());

	for (const line of lines) {
		const event = parseLine(line);
		if (!event) continue;

		const key = `${event.parent}${event.name}`;
		pending.set(key, event);
		logger.debug("Debouncer", `Event: ${event.name}`, { events: event.events });
		scheduleFlush();
	}
}
