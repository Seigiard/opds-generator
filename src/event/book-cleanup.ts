import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { logger } from "../utils/errors.ts";
import { config } from "../config.ts";

const [parent, name, _events] = Bun.argv.slice(2);

if (!parent || !name) {
	logger.error("BookCleanup", "Usage: bun book-cleanup.ts <parent> <name> <events>");
	process.exit(1);
}

const filePath = join(parent, name);
const relativePath = relative(config.filesPath, filePath);
const bookDataDir = join(config.dataPath, relativePath);

async function cleanup(): Promise<void> {
	logger.info("BookCleanup", `Removing: ${relativePath}`);

	try {
		await rm(bookDataDir, { recursive: true });
		logger.info("BookCleanup", `Done: ${relativePath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			logger.debug("BookCleanup", `Already removed: ${relativePath}`);
		} else {
			throw error;
		}
	}
}

try {
	await cleanup();
} catch (error) {
	logger.error("BookCleanup", `Failed: ${relativePath}`, error);
	process.exit(1);
}
