import chokidar from "chokidar";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { scanFiles, createSyncPlan, computeHash } from "./scanner.ts";
import { processBook, processFolder, cleanupOrphan } from "./processor.ts";
import { BOOK_EXTENSIONS } from "./types.ts";
import { logger } from "./utils/errors.ts";
import { SYNC_DEBOUNCE_MS, PROCESSING_CONCURRENCY } from "./constants.ts";
import { processInBatches } from "./utils/concurrency.ts";
import { config } from "./config.ts";
import { createRouter } from "./routes/index.ts";
import { generateAllFeeds } from "./feed-generator.ts";

let currentHash = "";
let isRebuilding = false;
let needsRebuild = false;
let rebuildTimer: Timer | null = null;
let bookCount = 0;
let folderCount = 0;

async function sync(): Promise<void> {
  if (isRebuilding) {
    needsRebuild = true;
    return;
  }
  isRebuilding = true;

  do {
    needsRebuild = false;
    logger.info("Sync", "Starting...");
    const startTime = Date.now();

    try {
      const files = await scanFiles(config.filesPath);
      logger.info("Sync", `Found ${files.length} books`);

      const plan = await createSyncPlan(files, config.dataPath);
      logger.info("Sync", `Plan: +${plan.toProcess.length} process, -${plan.toDelete.length} delete`);

      for (const path of plan.toDelete) {
        await cleanupOrphan(config.dataPath, path);
        logger.debug("Sync", `Deleted: ${path}`);
      }

      for (const folder of plan.folders) {
        await processFolder(folder.path, config.dataPath);
      }
      logger.debug("Sync", `Processed ${plan.folders.length} folders`);

      await processInBatches(
        plan.toProcess,
        (file) => {
          logger.debug("Sync", `Processing: ${file.relativePath}`);
          return processBook(file, config.filesPath, config.dataPath);
        },
        PROCESSING_CONCURRENCY
      );

      currentHash = computeHash(files);
      bookCount = files.length;
      folderCount = plan.folders.length;

      await generateAllFeeds(config.dataPath);

      const duration = Date.now() - startTime;
      logger.info("Sync", `Complete in ${duration}ms`, { hash: currentHash, books: bookCount });
    } catch (error) {
      logger.error("Sync", "Sync failed", error);
    }
  } while (needsRebuild);

  isRebuilding = false;
}

function isBookFile(filename: string): boolean {
  const ext = extname(filename).slice(1).toLowerCase();
  return BOOK_EXTENSIONS.includes(ext);
}

function scheduleSync(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    void sync();
    rebuildTimer = null;
  }, SYNC_DEBOUNCE_MS);
}

function startWatcher(): void {
  const watcher = chokidar.watch(config.filesPath, {
    ignored: (path, stats) => stats?.isFile() === true && !isBookFile(path),
    persistent: true,
    ignoreInitial: true,
    usePolling: config.devMode,
    interval: 1000,
  });

  watcher
    .on("add", (path) => {
      logger.debug("Watch", `add: ${path}`);
      scheduleSync();
    })
    .on("change", (path) => {
      logger.debug("Watch", `change: ${path}`);
      scheduleSync();
    })
    .on("unlink", (path) => {
      logger.debug("Watch", `unlink: ${path}`);
      scheduleSync();
    });

  logger.info("Watch", `Watching ${config.filesPath}`);
}

const router = createRouter({
  getCurrentHash: () => currentHash,
  isRebuilding: () => isRebuilding,
  getBookCount: () => bookCount,
  getFolderCount: () => folderCount,
  triggerSync: () => void sync(),
});

const server = Bun.serve({
  port: config.port,
  fetch: router,
});

logger.info("Init", "Starting OPDS Generator", {
  files: config.filesPath,
  data: config.dataPath,
  port: config.port,
  devMode: config.devMode,
});

await mkdir(config.dataPath, { recursive: true });

// Copy XSLT template and styles to data folder for browser rendering
await Bun.write(join(config.dataPath, "layout.xsl"), Bun.file("src/template/layout.xsl"));
await Bun.write(join(config.dataPath, "style.css"), Bun.file("src/template/style.css"));

await sync();
startWatcher();
logger.info("Server", `Listening on http://localhost:${server.port}`);
