import { rm } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logging/index.ts";

// Builds before issue #18 dumped these into the served /data volume and never removed them.
const LEGACY_HEAP_SNAPSHOTS = ["heap-snapshot-100.json", "heap-snapshot-3000.json"];

export async function removeLegacyHeapSnapshots(dataPath: string): Promise<string[]> {
  const removed: string[] = [];

  for (const name of LEGACY_HEAP_SNAPSHOTS) {
    const path = join(dataPath, name);

    if (!(await Bun.file(path).exists())) continue;

    await rm(path, { force: true });
    removed.push(name);
  }

  return removed;
}

/** Startup housekeeping: a failure is logged and never blocks synchronization. */
export async function removeHeapSnapshotLeftovers(dataPath: string): Promise<void> {
  try {
    const removed = await removeLegacyHeapSnapshots(dataPath);

    if (removed.length > 0) log.info("Server", "Removed leftover heap snapshots", { file: removed.join(", ") });
  } catch (error) {
    log.warn("Server", "Failed to remove leftover heap snapshots", { error: String(error) });
  }
}
