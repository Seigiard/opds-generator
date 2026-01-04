import { dirname, relative } from "node:path";
import { logger } from "../utils/errors.ts";
import { config } from "../config.ts";

const [folderDataDir, _name, _events] = Bun.argv.slice(2);

if (!folderDataDir) {
	logger.error("ParentMetaSync", "Usage: bun parent-meta-sync.ts <folder-data-dir> [name] [events]");
	process.exit(1);
}

const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
const relativePath = relative(config.dataPath, normalizedDir);

const parentDataDir = dirname(normalizedDir);
const parentRelativePath = relative(config.dataPath, parentDataDir);

async function sync(): Promise<void> {
	if (parentDataDir === config.dataPath || parentRelativePath === ".") {
		logger.info("ParentMetaSync", "Parent is root, running folder-meta-sync for root");
		await Bun.$`bun run src/event/folder-meta-sync.ts ${config.dataPath}`.quiet();
	} else {
		logger.info("ParentMetaSync", `Running folder-meta-sync for: ${parentRelativePath}`);
		await Bun.$`bun run src/event/folder-meta-sync.ts ${parentDataDir}`.quiet();
	}
}

try {
	await sync();
} catch (error) {
	logger.error("ParentMetaSync", `Failed for parent of: ${relativePath}`, error);
	process.exit(1);
}
