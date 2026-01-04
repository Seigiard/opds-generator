import { config } from "./config.ts";
import { createRouter } from "./routes/index.ts";
import { logger } from "./utils/errors.ts";

let currentHash = "";
let isRebuilding = false;
let bookCount = 0;
let folderCount = 0;

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
	fetch: router,
});

logger.info("Server", `Listening on http://localhost:${server.port}`);
