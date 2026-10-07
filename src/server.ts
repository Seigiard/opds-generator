import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { FEED_FILE } from "./constants.ts";
import { buildFeedModel } from "./render/feed-model.ts";
import { renderXml } from "./render/feed-xml.ts";
import { log } from "./logging/index.ts";
import { isRawBooksEvent, isRawDataEvent } from "./processing/types.ts";
import { adaptBooksEvent } from "./processing/adapters/books-adapter.ts";
import { adaptDataEvent } from "./processing/adapters/data-adapter.ts";
import { adaptSyncPlan } from "./processing/adapters/sync-plan-adapter.ts";
import { createCatalogueProcessor, type CatalogueProcessor } from "./processing/catalogue-processor.ts";
import { bookSync } from "./processing/handlers/book-sync.ts";
import { bookCleanup } from "./processing/handlers/book-cleanup.ts";
import { folderSync } from "./processing/handlers/folder-sync.ts";
import { folderCleanup } from "./processing/handlers/folder-cleanup.ts";
import { parentMetaSync } from "./processing/handlers/parent-meta-sync.ts";
import { folderEntryXmlChanged } from "./processing/handlers/folder-entry-xml-changed.ts";
import { folderMetaSync } from "./processing/handlers/folder-meta-sync.ts";
import { buildContext } from "./context.ts";
import { scanFiles, createSyncPlan, removeLegacyHeapSnapshots } from "./scanner.ts";

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 8_000;

let isReady = false;

let isSyncing = false;

async function doSync(processor: CatalogueProcessor): Promise<void> {
  log.info("InitialSync", "Starting");
  const startTime = Date.now();

  await mkdir(config.dataPath, { recursive: true });

  const feedPath = join(config.dataPath, FEED_FILE);

  if (!(await Bun.file(feedPath).exists())) {
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

  const files = await scanFiles(config.filesPath);
  log.info("InitialSync", "Books found", { books_found: files.length });

  const plan = await createSyncPlan(files, config.dataPath);
  log.info("InitialSync", "Sync plan created", {
    books_process: plan.toProcess.length,
    books_delete: plan.toDelete.length,
    folders_count: plan.folders.length,
  });

  const events = adaptSyncPlan(plan, config.filesPath);
  processor.submit(events);

  const duration = Date.now() - startTime;
  log.info("InitialSync", "Events queued", { entries_count: events.length, duration_ms: duration });
}

async function removeHeapSnapshotLeftovers(): Promise<void> {
  try {
    const removed = await removeLegacyHeapSnapshots(config.dataPath);

    if (removed.length > 0) log.info("InitialSync", "Removed leftover heap snapshots", { file: removed.join(", ") });
  } catch (error) {
    log.warn("InitialSync", "Failed to remove leftover heap snapshots", { error: String(error) });
  }
}

async function initialSync(processor: CatalogueProcessor): Promise<void> {
  isSyncing = true;

  try {
    await removeHeapSnapshotLeftovers();
    await doSync(processor);
  } finally {
    isSyncing = false;
  }
}

async function resync(processor: CatalogueProcessor): Promise<void> {
  isSyncing = true;

  try {
    log.info("Resync", "Starting full resync");
    const entries = await readdir(config.dataPath);
    await Promise.all(entries.map((entry) => rm(join(config.dataPath, entry), { recursive: true, force: true })));
    log.info("Resync", "Cleared data directory");
    await doSync(processor);
  } finally {
    isSyncing = false;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function startReconciliation(processor: CatalogueProcessor, signal: AbortSignal): Promise<void> {
  const intervalMs = config.reconcileInterval * 1000;

  while (!signal.aborted) {
    await sleep(intervalMs, signal).catch(() => {});

    if (signal.aborted) break;

    if (isSyncing) {
      log.debug("Reconciliation", "Skipped: sync in progress");
      continue;
    }

    const { pending } = processor.status();

    if (pending > 0) {
      log.debug("Reconciliation", `Skipped: queue has ${pending} pending events`);
      continue;
    }

    try {
      log.info("Reconciliation", "Starting periodic reconciliation");
      isSyncing = true;

      try {
        await doSync(processor);
      } finally {
        isSyncing = false;
      }

      log.info("Reconciliation", "Completed");
    } catch (error) {
      log.error("Reconciliation", "Failed", error);
    }
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();

  try {
    const ctx = await buildContext();

    const processor = createCatalogueProcessor({
      deps: { config: ctx.config, logger: ctx.logger, fs: ctx.fs },
      handlers: {
        BookCreated: bookSync,
        BookDeleted: bookCleanup,
        FolderCreated: folderSync,
        FolderDeleted: folderCleanup,
        EntryXmlChanged: parentMetaSync,
        FolderEntryXmlChanged: folderEntryXmlChanged,
        FolderMetaSyncRequested: folderMetaSync,
      },
    });

    const consumerTask = processor.start(controller.signal);
    log.info("Server", "Consumer started");
    isReady = true;

    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);

        if (req.method === "POST" && url.pathname === "/events/books") {
          if (!isReady) return new Response("Queue not ready", { status: 503 });

          try {
            const body = await req.json();

            if (!isRawBooksEvent(body)) {
              log.warn("Server", "Invalid books event schema", { body });

              return new Response("Invalid event", { status: 400 });
            }

            const event = adaptBooksEvent(body, ctx.dedup);

            if (event === null) return new Response("Deduplicated", { status: 202 });
            processor.submit(event);

            return new Response("OK", { status: 202 });
          } catch (error) {
            log.error("Server", "Failed to process books event", error);

            return new Response("Error", { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/events/data") {
          if (!isReady) return new Response("Queue not ready", { status: 503 });

          try {
            const body = await req.json();

            if (!isRawDataEvent(body)) {
              log.warn("Server", "Invalid data event schema", { body });

              return new Response("Invalid event", { status: 400 });
            }

            const event = adaptDataEvent(body, ctx.dedup);

            if (event === null) return new Response("Deduplicated", { status: 202 });
            processor.submit(event);

            return new Response("OK", { status: 202 });
          } catch (error) {
            log.error("Server", "Failed to process data event", error);

            return new Response("Error", { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/resync") {
          if (!isReady) return new Response("Queue not ready", { status: 503 });

          if (isSyncing) return new Response("Sync already in progress", { status: 409 });
          resync(processor).catch((error) => log.error("Server", "Resync failed", error));

          return new Response("Resync started", { status: 202 });
        }

        return new Response("Not found", { status: 404 });
      },
    });

    log.info("Server", "Listening", { port: server.port });

    let reconcileTask: Promise<void> | null = null;

    const shutdown = async () => {
      log.info("Server", "Shutting down");
      server.stop();
      controller.abort();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const timeout = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS);
      });

      const outcome = await Promise.race([Promise.allSettled([consumerTask, reconcileTask].filter(Boolean)), timeout]);
      clearTimeout(timeoutId);

      if (outcome === "timeout") {
        log.warn("Server", "Shutdown deadline reached; active work or cleanup is unfinished");
      }

      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    await initialSync(processor);

    if (!controller.signal.aborted && config.reconcileInterval > 0) {
      reconcileTask = startReconciliation(processor, controller.signal);
      log.info("Server", `Periodic reconciliation enabled (every ${config.reconcileInterval}s)`);
    }
  } catch (error) {
    log.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

void main();
