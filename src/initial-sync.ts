import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { scanFiles, createSyncPlan } from "./scanner.ts";
import { config } from "./config.ts";
import { logger } from "./utils/errors.ts";
import { generateAllFeeds } from "./feed-generator.ts";

async function processBook(relativePath: string): Promise<void> {
	const parent = dirname(join(config.filesPath, relativePath)) + "/";
	const name = relativePath.split("/").pop() ?? "";

	const result =
		await Bun.$`bun run src/event/book-sync.ts ${parent} ${name} INITIAL_SYNC`.quiet();
	if (result.exitCode !== 0) {
		logger.warn("InitialSync", `Failed to process: ${relativePath}`);
	}
}

async function processFolder(relativePath: string): Promise<void> {
	const parent = dirname(join(config.filesPath, relativePath)) + "/";
	const name = relativePath.split("/").pop() ?? "";

	const result =
		await Bun.$`bun run src/event/folder-sync.ts ${parent} ${name} INITIAL_SYNC`.quiet();
	if (result.exitCode !== 0) {
		logger.warn("InitialSync", `Failed to process folder: ${relativePath}`);
	}
}

async function deleteOrphan(relativePath: string): Promise<void> {
	const dataDir = join(config.dataPath, relativePath);
	try {
		await rm(dataDir, { recursive: true });
		logger.debug("InitialSync", `Deleted orphan: ${relativePath}`);
	} catch {
		// Already deleted
	}
}

async function initialSync(): Promise<void> {
	logger.info("InitialSync", "Starting initial sync...");
	const startTime = Date.now();

	await mkdir(config.dataPath, { recursive: true });

	const files = await scanFiles(config.filesPath);
	logger.info("InitialSync", `Found ${files.length} books`);

	const plan = await createSyncPlan(files, config.dataPath);
	logger.info("InitialSync", `Plan: +${plan.toProcess.length} process, -${plan.toDelete.length} delete, ${plan.folders.length} folders`);

	for (const path of plan.toDelete) {
		await deleteOrphan(path);
	}

	for (const folder of plan.folders) {
		await processFolder(folder.path);
	}

	for (const file of plan.toProcess) {
		await processBook(file.relativePath);
	}

	await generateAllFeeds(config.dataPath);

	const duration = Date.now() - startTime;
	logger.info("InitialSync", `Completed in ${duration}ms`, {
		books: files.length,
		processed: plan.toProcess.length,
		deleted: plan.toDelete.length,
	});
}

try {
	await initialSync();
} catch (error) {
	logger.error("InitialSync", "Failed", error);
	process.exit(1);
}
