import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { FEED_FILE } from "../constants.ts";
import { log } from "../logging/index.ts";
import { buildFeedModel } from "../render/feed-model.ts";
import { renderXml } from "../render/feed-xml.ts";
import { adaptSyncPlan } from "../processing/adapters/sync-plan-adapter.ts";
import { scanFiles, createSyncPlan, removeLegacyHeapSnapshots } from "../scanner.ts";
import type { CatalogueScanner } from "./lifecycle.ts";

async function seedRootFeed(): Promise<void> {
  const feedPath = join(config.dataPath, FEED_FILE);

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

async function removeHeapSnapshotLeftovers(): Promise<void> {
  try {
    const removed = await removeLegacyHeapSnapshots(config.dataPath);

    if (removed.length > 0) log.info("InitialSync", "Removed leftover heap snapshots", { file: removed.join(", ") });
  } catch (error) {
    log.warn("InitialSync", "Failed to remove leftover heap snapshots", { error: String(error) });
  }
}

async function clearDataDirectory(): Promise<void> {
  log.info("Resync", "Starting full resync");
  const entries = await readdir(config.dataPath);
  await Promise.all(entries.map((entry) => rm(join(config.dataPath, entry), { recursive: true, force: true })));
  log.info("Resync", "Cleared data directory");
}

/** The nginx 503 gate reads `/data/feed.xml`: it is absent until the seed below writes it, and a resync's wipe removes it again. */
export const diskScanner: CatalogueScanner = {
  async scan(request) {
    if (request.kind === "initial") await removeHeapSnapshotLeftovers();

    if (request.kind === "resync") await clearDataDirectory();

    log.info("InitialSync", "Starting");
    const startTime = Date.now();

    await mkdir(config.dataPath, { recursive: true });
    await seedRootFeed();

    const files = await scanFiles(config.filesPath);
    log.info("InitialSync", "Books found", { books_found: files.length });

    const plan = await createSyncPlan(files, config.dataPath);
    log.info("InitialSync", "Sync plan created", {
      books_process: plan.toProcess.length,
      books_delete: plan.toDelete.length,
      folders_count: plan.folders.length,
    });

    const events = adaptSyncPlan(plan, config.filesPath);
    log.info("InitialSync", "Events queued", { entries_count: events.length, duration_ms: Date.now() - startTime });

    return events;
  },
};
