import chokidar from "chokidar";
import { relative } from "node:path";
import { generateFeedFile } from "./feed-generator.ts";
import { logger } from "./utils/errors.ts";
import { SYNC_DEBOUNCE_MS } from "./constants.ts";
import { config } from "./config.ts";

const pendingRegenerations = new Set<string>();
let regenerationTimer: Timer | null = null;
let isRegenerating = false;
let needsRegeneration = false;
let dataPathRef = "";

/**
 * Extracts the parent folder path from an XML file path.
 * - entry.xml in /data/Science/book.epub/entry.xml → "Science"
 * - _entry.xml in /data/Science/NewFolder/_entry.xml → "Science"
 */
function getParentFolderPath(xmlPath: string, dataPath: string): string | null {
  const relativePath = relative(dataPath, xmlPath);
  const parts = relativePath.split("/");
  const filename = parts.pop();

  if (filename === "entry.xml") {
    // Book entry: /path/book.epub/entry.xml → parent is /path
    parts.pop(); // remove book.epub folder
    return parts.join("/");
  }

  if (filename === "_entry.xml") {
    // Folder entry: /path/folder/_entry.xml → parent is /path
    parts.pop(); // remove folder
    return parts.join("/");
  }

  return null;
}

/**
 * Schedules a folder for feed regeneration (no cascade).
 */
export function scheduleFeedRegeneration(folderPath: string): void {
  pendingRegenerations.add(folderPath);
  scheduleRun();
}

function scheduleRun(): void {
  if (regenerationTimer) clearTimeout(regenerationTimer);
  regenerationTimer = setTimeout(() => {
    void runRegeneration();
    regenerationTimer = null;
  }, SYNC_DEBOUNCE_MS);
}

async function runRegeneration(): Promise<void> {
  if (isRegenerating) {
    needsRegeneration = true;
    return;
  }
  isRegenerating = true;

  do {
    needsRegeneration = false;

    const folders = Array.from(pendingRegenerations);
    pendingRegenerations.clear();

    if (folders.length === 0) break;

    logger.debug("FeedRegen", `Regenerating ${folders.length} feeds`);

    for (const folder of folders) {
      await generateFeedFile(folder, dataPathRef);
    }
  } while (needsRegeneration);

  isRegenerating = false;
}

/**
 * Initializes the feed watcher with chokidar.
 * Watches /data for XML changes and triggers feed regeneration.
 */
export function initFeedWatcher(dataPath: string): void {
  dataPathRef = dataPath;

  const watcher = chokidar.watch(dataPath, {
    ignored: (path) => {
      // Only watch entry.xml and _entry.xml
      if (path.endsWith("/feed.xml")) return true;
      if (path.endsWith("/entry.xml") || path.endsWith("/_entry.xml")) return false;
      if (path.endsWith(".xml")) return true;
      return false; // watch directories
    },
    ignoreInitial: true,
    persistent: true,
    usePolling: config.devMode,
    interval: 1000,
  });

  watcher
    .on("add", (path) => handleXmlChange("add", path))
    .on("change", (path) => handleXmlChange("change", path))
    .on("unlink", (path) => handleXmlChange("unlink", path));

  logger.info("FeedWatcher", `Watching ${dataPath} for XML changes`);
}

function handleXmlChange(event: string, xmlPath: string): void {
  const parentFolder = getParentFolderPath(xmlPath, dataPathRef);
  if (parentFolder === null) return;

  logger.debug("FeedWatcher", `${event}: ${xmlPath} → regenerate ${parentFolder || "/"}`);
  scheduleFeedRegeneration(parentFolder);
}
