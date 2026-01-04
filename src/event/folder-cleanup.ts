import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { logger } from "../utils/errors.ts";
import { config } from "../config.ts";

const [parent, name, _events] = Bun.argv.slice(2);

if (!parent || !name) {
	logger.error("FolderCleanup", "Usage: bun folder-cleanup.ts <parent> <name> <events>");
	process.exit(1);
}

const folderPath = join(parent, name);
const relativePath = relative(config.filesPath, folderPath);
const folderDataDir = join(config.dataPath, relativePath);

async function cleanup(): Promise<void> {
	logger.info("FolderCleanup", `Removing: ${relativePath}`);

	try {
		await rm(folderDataDir, { recursive: true });
		logger.info("FolderCleanup", `Done: ${relativePath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			logger.debug("FolderCleanup", `Already removed: ${relativePath}`);
		} else {
			throw error;
		}
	}
}

try {
	await cleanup();
} catch (error) {
	logger.error("FolderCleanup", `Failed: ${relativePath}`, error);
	process.exit(1);
}
