import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Feed } from "opds-ts/v1.2";
import { config } from "./config.ts";
import { FEED_FILE } from "./constants.ts";
import { log } from "./logging/index.ts";
import { isRawBooksEvent, isRawDataEvent } from "./effect/types.ts";
import { adaptBooksEvent } from "./effect/adapters/books-adapter.ts";
import { adaptDataEvent } from "./effect/adapters/data-adapter.ts";
import { adaptSyncPlan } from "./effect/adapters/sync-plan-adapter.ts";
import { startConsumer } from "./effect/consumer.ts";
import { bookSync } from "./effect/handlers/book-sync.ts";
import { bookCleanup } from "./effect/handlers/book-cleanup.ts";
import { folderSync } from "./effect/handlers/folder-sync.ts";
import { folderCleanup } from "./effect/handlers/folder-cleanup.ts";
import { parentMetaSync } from "./effect/handlers/parent-meta-sync.ts";
import { folderEntryXmlChanged } from "./effect/handlers/folder-entry-xml-changed.ts";
import { folderMetaSync } from "./effect/handlers/folder-meta-sync.ts";
import { buildContext, type AppContext } from "./context.ts";
import { scanFiles, createSyncPlan } from "./scanner.ts";

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 8_000;

let isReady = false;
let isSyncing = false;

function registerHandlers(ctx: AppContext): void {
  ctx.handlers.register("BookCreated", bookSync);
  ctx.handlers.register("BookDeleted", bookCleanup);
  ctx.handlers.register("FolderCreated", folderSync);
  ctx.handlers.register("FolderDeleted", folderCleanup);
  ctx.handlers.register("EntryXmlChanged", parentMetaSync);
  ctx.handlers.register("FolderEntryXmlChanged", folderEntryXmlChanged);
  ctx.handlers.register("FolderMetaSyncRequested", folderMetaSync);
}

async function doSync(ctx: AppContext): Promise<void> {
  log.info("InitialSync", "Starting");
  const startTime = Date.now();

  await mkdir(config.dataPath, { recursive: true });

  const feedPath = join(config.dataPath, FEED_FILE);
  if (!(await Bun.file(feedPath).exists())) {
    const seed = new Feed("urn:opds:catalog:root", "Catalog")
      .addSelfLink(`/${FEED_FILE}`, "navigation")
      .addNavigationLink("start", `/${FEED_FILE}`)
      .setKind("navigation");
    const xml = seed
      .toXml({ prettyPrint: true })
      .replace(
        '<?xml version="1.0" encoding="utf-8"?>',
        `<?xml version="1.0" encoding="utf-8"?>\n<?xml-stylesheet href="/static/layout.xsl" type="text/xsl"?>`,
      );
    await Bun.write(feedPath, xml);
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
  ctx.queue.enqueueMany(events);

  const duration = Date.now() - startTime;
  log.info("InitialSync", "Events queued", { entries_count: events.length, duration_ms: duration });
}

async function initialSync(ctx: AppContext): Promise<void> {
  isSyncing = true;
  try {
    await doSync(ctx);
  } finally {
    isSyncing = false;
  }
}

async function resync(ctx: AppContext): Promise<void> {
  isSyncing = true;
  try {
    log.info("Resync", "Starting full resync");
    const entries = await readdir(config.dataPath);
    await Promise.all(entries.map((entry) => rm(join(config.dataPath, entry), { recursive: true, force: true })));
    log.info("Resync", "Cleared data directory");
    await doSync(ctx);
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

async function startReconciliation(ctx: AppContext, signal: AbortSignal): Promise<void> {
  const intervalMs = config.reconcileInterval * 1000;
  while (!signal.aborted) {
    await sleep(intervalMs, signal).catch(() => {});
    if (signal.aborted) break;

    if (isSyncing) {
      log.debug("Reconciliation", "Skipped: sync in progress");
      continue;
    }

    if (ctx.queue.size > 0) {
      log.debug("Reconciliation", `Skipped: queue has ${ctx.queue.size} pending events`);
      continue;
    }

    try {
      log.info("Reconciliation", "Starting periodic reconciliation");
      isSyncing = true;
      try {
        await doSync(ctx);
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

    registerHandlers(ctx);
    log.info("Server", "Handlers registered");

    const consumerTask = startConsumer(ctx, controller.signal);
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
            ctx.queue.enqueue(event);
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
            ctx.queue.enqueue(event);
            return new Response("OK", { status: 202 });
          } catch (error) {
            log.error("Server", "Failed to process data event", error);
            return new Response("Error", { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/resync") {
          if (!isReady) return new Response("Queue not ready", { status: 503 });
          if (isSyncing) return new Response("Sync already in progress", { status: 409 });
          resync(ctx).catch((error) => log.error("Server", "Resync failed", error));
          return new Response("Resync started", { status: 202 });
        }

        return new Response("Not found", { status: 404 });
      },
    });

    log.info("Server", "Listening", { port: server.port });

    await initialSync(ctx);

    let reconcileTask: Promise<void> | null = null;
    if (config.reconcileInterval > 0) {
      reconcileTask = startReconciliation(ctx, controller.signal);
      log.info("Server", `Periodic reconciliation enabled (every ${config.reconcileInterval}s)`);
    }

    const shutdown = async () => {
      log.info("Server", "Shutting down");
      server.stop();
      controller.abort();
      const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
      await Promise.race([Promise.allSettled([consumerTask, reconcileTask].filter(Boolean)), timeout]);
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    log.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

void main();
