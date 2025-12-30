import { generateFeedFile } from "./feed-generator.ts";
import { getAncestorPaths } from "./utils/path.ts";
import { logger } from "./utils/errors.ts";
import { SYNC_DEBOUNCE_MS } from "./constants.ts";

const pendingRegenerations = new Set<string>();
let regenerationTimer: Timer | null = null;
let isRegenerating = false;
let needsRegeneration = false;
let dataPathRef = "";

/**
 * Initializes the feed regeneration system with the data path.
 */
export function initFeedRegeneration(dataPath: string): void {
  dataPathRef = dataPath;
  logger.info("FeedRegen", "Feed regeneration initialized");
}

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

    logger.debug("FeedRegen", `Regenerating ${folders.length} feeds`);

    for (const folder of folders) {
      await generateFeedFile(folder, dataPathRef);
    }
  } while (needsRegeneration);

  isRegenerating = false;
}
