import { generateFeedFile } from "./feed-generator.ts";
import { logger } from "./utils/errors.ts";
import { SYNC_DEBOUNCE_MS } from "./constants.ts";
import { config } from "./config.ts";

const pendingRegenerations = new Set<string>();
let regenerationTimer: Timer | null = null;
let isRegenerating = false;
let needsRegeneration = false;

/**
 * Schedules a folder for feed regeneration (debounced).
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
      await generateFeedFile(folder, config.dataPath);
    }
  } while (needsRegeneration);

  isRegenerating = false;
}
