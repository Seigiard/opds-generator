import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { FEED_FILE } from "../constants.ts";
import { log } from "../logging/index.ts";
import { buildFeedModel } from "../render/feed-model.ts";
import { renderXml } from "../render/feed-xml.ts";
import { adaptSyncPlan } from "../processing/adapters/sync-plan-adapter.ts";
import { scanFiles, createSyncPlan, removeLegacyHeapSnapshots } from "../scanner.ts";
import type { CatalogueScanner } from "./lifecycle.ts";

async function seedRootFeed(dataPath: string): Promise<void> {
  const feedPath = join(dataPath, FEED_FILE);

  if (await Bun.file(feedPath).exists()) return;

  const seedModel = buildFeedModel({
    id: "urn:opds:catalog:root",
    title: "Catalog",
    updated: new Date().toISOString(),
    kind: "navigation",
    selfHref: `/${FEED_FILE}`,
    startHref: `/${FEED_FILE}`,
    fragments: [],
  });

  await Bun.write(feedPath, renderXml(seedModel));
  log.info("InitialSync", "Seed feed.xml created");
}

async function removeHeapSnapshotLeftovers(dataPath: string): Promise<void> {
  try {
    const removed = await removeLegacyHeapSnapshots(dataPath);

    if (removed.length > 0) log.info("InitialSync", "Removed leftover heap snapshots", { file: removed.join(", ") });
  } catch (error) {
    log.warn("InitialSync", "Failed to remove leftover heap snapshots", { error: String(error) });
  }
}

/** The nginx 503 gate reads `/data/feed.xml`: it is absent until the seed below writes it after a successful scan, and no scan ever removes it. */
export function createDiskScanner({ filesPath, dataPath }: { readonly filesPath: string; readonly dataPath: string }): CatalogueScanner {
  return {
    outputPath: dataPath,
    async scan(request, signal) {
      if (request.kind === "initial") await removeHeapSnapshotLeftovers(dataPath);

      log.info("InitialSync", "Starting", { scan_kind: request.kind, scan_force: request.force });
      const startTime = Date.now();

      await mkdir(dataPath, { recursive: true });

      const files = await scanFiles(filesPath, signal);
      log.info("InitialSync", "Books found", { books_found: files.length });

      const plan = await createSyncPlan(files, dataPath, { force: request.force, signal });
      log.info("InitialSync", "Sync plan created", {
        books_process: plan.toProcess.length,
        books_delete: plan.toDelete.length,
        folders_count: plan.folders.length,
      });

      signal.throwIfAborted();
      // Seeding ends the nginx 503s, so it waits until the books directory has been read and planned.
      await seedRootFeed(dataPath);
      const events = adaptSyncPlan(plan, filesPath);
      log.info("InitialSync", "Events queued", { entries_count: events.length, duration_ms: Date.now() - startTime });

      return events;
    },
  };
}

export const diskScanner = createDiskScanner(config);
