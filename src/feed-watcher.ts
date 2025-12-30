import { watch, type FSWatcher } from "node:fs";
import { generateFeedFile } from "./feed-generator.ts";
import { getAncestorPaths, xmlFileToFolderPath } from "./utils/path.ts";
import { logger } from "./utils/errors.ts";
import { SYNC_DEBOUNCE_MS } from "./constants.ts";

const pendingRegenerations = new Set<string>();
let regenerationTimer: Timer | null = null;
let isRegenerating = false;
let needsRegeneration = false;
let watcher: FSWatcher | null = null;
let dataPathRef = "";

/**
 * Schedules a folder for feed regeneration.
 * The regeneration will be debounced and will cascade up to root.
 */
export function scheduleFeedRegeneration(folderPath: string): void {
  const ancestors = getAncestorPaths(folderPath);
  for (const path of ancestors) {
    pendingRegenerations.add(path);
  }

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

    // Sort by depth (deepest first) for bottom-up regeneration
    const folders = Array.from(pendingRegenerations).sort((a, b) => {
      const depthA = a === "" ? 0 : a.split("/").length;
      const depthB = b === "" ? 0 : b.split("/").length;
      return depthB - depthA;
    });

    pendingRegenerations.clear();

    if (folders.length === 0) break;

    logger.debug("FeedWatcher", `Regenerating ${folders.length} feeds`);

    for (const folder of folders) {
      await generateFeedFile(folder, dataPathRef);
    }
  } while (needsRegeneration);

  isRegenerating = false;
}

function isWatchedFile(filename: string): boolean {
  return filename === "entry.xml" || filename === "_entry.xml" || filename === "_feed.xml";
}

/**
 * Starts watching the data directory for XML file changes.
 * When entry.xml, _entry.xml, or _feed.xml changes, regenerates affected feeds.
 */
export function startFeedWatcher(dataPath: string): void {
  dataPathRef = dataPath;

  watcher = watch(dataPath, { recursive: true }, (event, filename) => {
    if (!filename) return;

    const basename = filename.split("/").pop() || "";
    if (!isWatchedFile(basename)) return;

    // Ignore feed.xml changes (we generate those)
    if (basename === "feed.xml") return;

    const folderPath = xmlFileToFolderPath(filename);
    if (folderPath === null) return;

    logger.debug("FeedWatcher", `${event}: ${filename} -> regenerate ${folderPath || "/"}`);
    scheduleFeedRegeneration(folderPath);
  });

  logger.info("FeedWatcher", `Watching ${dataPath} for feed updates`);
}

/**
 * Stops the feed watcher.
 */
export function stopFeedWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (regenerationTimer) {
    clearTimeout(regenerationTimer);
    regenerationTimer = null;
  }
}
