import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, basename, extname, normalize, isAbsolute } from "node:path";
import { scanFiles, createSyncPlan, computeHash } from "./scanner.ts";
import { processBook, processFolder, cleanupOrphan } from "./processor.ts";
import { buildFeed } from "./opds.ts";
import { BOOK_EXTENSIONS } from "./types.ts";
import { logger } from "./utils/errors.ts";
import { SYNC_DEBOUNCE_MS, IMAGE_CACHE_MAX_AGE, PLACEHOLDER_CACHE_MAX_AGE } from "./constants.ts";
import { config } from "./config.ts";

function resolveSafePath(basePath: string, userPath: string): string | null {
  if (isAbsolute(userPath)) return null;
  const fullPath = normalize(join(basePath, userPath));
  const normalizedBase = normalize(basePath);
  if (!fullPath.startsWith(normalizedBase + "/") && fullPath !== normalizedBase) {
    return null;
  }
  return fullPath;
}

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
        await processFolder(folder.path, config.dataPath, config.baseUrl);
      }
      logger.debug("Sync", `Processed ${plan.folders.length} folders`);

      for (const file of plan.toProcess) {
        logger.debug("Sync", `Processing: ${file.relativePath}`);
        await processBook(file, config.filesPath, config.dataPath);
      }

      currentHash = computeHash(files);
      bookCount = files.length;
      folderCount = plan.folders.length;

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

function shouldTriggerSync(filename: string): boolean {
  if (isBookFile(filename)) return true;
  const ext = extname(filename);
  if (!ext) return true;
  return false;
}

function startWatcher(): void {
  watch(config.filesPath, { recursive: true }, (event, filename) => {
    if (filename && shouldTriggerSync(filename)) {
      logger.debug("Watch", `${event}: ${filename}`);
      scheduleSync();
    }
  });
  logger.info("Watch", `Watching ${config.filesPath}`);
}

const PLACEHOLDER_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x78, 0x78, 0x78, 0x00, 0x00, 0x02, 0x3d, 0x01, 0x26, 0xf8, 0x7e, 0xb1, 0xa8,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const imageCacheControl = config.devMode ? "no-store" : `public, max-age=${IMAGE_CACHE_MAX_AGE}`;
const placeholderCacheControl = config.devMode ? "no-store" : `public, max-age=${PLACEHOLDER_CACHE_MAX_AGE}`;

async function handleOpds(feedPath: string, req: Request): Promise<Response> {
  const feed = await buildFeed(feedPath, config.dataPath);

  if (feed) {
    const etag = config.devMode ? `"dev-${Date.now()}"` : `"${currentHash}-${feedPath}"`;
    const ifNoneMatch = req.headers.get("If-None-Match");

    if (!config.devMode && ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(feed, {
      headers: {
        "Content-Type": "application/atom+xml;charset=utf-8",
        ETag: etag,
        "Cache-Control": config.devMode ? "no-store" : "no-cache",
      },
    });
  }

  return new Response("Feed not found", { status: 404 });
}

async function handleDownload(fullPath: string, fileName: string): Promise<Response> {
  const file = Bun.file(fullPath);

  if (await file.exists()) {
    return new Response(file, {
      headers: {
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  }

  return new Response("File not found", { status: 404 });
}

async function handleCover(dataDir: string): Promise<Response> {
  const coverFile = Bun.file(join(dataDir, "cover.jpg"));

  if (await coverFile.exists()) {
    return new Response(coverFile, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": imageCacheControl,
      },
    });
  }

  return new Response(PLACEHOLDER_PNG, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": placeholderCacheControl,
    },
  });
}

async function handleThumbnail(dataDir: string): Promise<Response> {
  const thumbFile = Bun.file(join(dataDir, "thumb.jpg"));

  if (await thumbFile.exists()) {
    return new Response(thumbFile, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": imageCacheControl,
      },
    });
  }

  return new Response(PLACEHOLDER_PNG, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": placeholderCacheControl,
    },
  });
}

const server = Bun.serve({
  port: config.port,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") {
      return Response.redirect(`${config.baseUrl}/opds`, 302);
    }

    if (path === "/health") {
      return Response.json({
        status: isRebuilding ? "rebuilding" : "ready",
        books: bookCount,
        folders: folderCount,
        hash: currentHash,
      });
    }

    if (path === "/reset") {
      // TODO: restore DEV_MODE check after fixing Bun --watch env bug
      if (isRebuilding) {
        return Response.json({ status: "busy", message: "Already rebuilding" }, { status: 429 });
      }
      logger.info("Reset", "Clearing data and resyncing...");
      await Bun.$`rm -rf ${config.dataPath}/*`.quiet();
      void sync();
      return Response.json({ status: "reset", message: "Data cleared, resync started" });
    }

    if (path === "/opds" || path.startsWith("/opds/")) {
      const userPath = path === "/opds" ? "" : decodeURIComponent(path.slice(6));
      const safePath = userPath === "" ? config.dataPath : resolveSafePath(config.dataPath, userPath);
      if (!safePath) return new Response("Invalid path", { status: 400 });
      const feedPath = userPath === "" ? "" : userPath;
      return handleOpds(feedPath, req);
    }

    if (path.startsWith("/download/")) {
      const userPath = decodeURIComponent(path.slice(10));
      const safePath = resolveSafePath(config.filesPath, userPath);
      if (!safePath) return new Response("Invalid path", { status: 400 });
      return handleDownload(safePath, basename(userPath));
    }

    if (path.startsWith("/cover/")) {
      const userPath = decodeURIComponent(path.slice(7));
      const safePath = resolveSafePath(config.dataPath, userPath);
      if (!safePath) return new Response("Invalid path", { status: 400 });
      return handleCover(safePath);
    }

    if (path.startsWith("/thumbnail/")) {
      const userPath = decodeURIComponent(path.slice(11));
      const safePath = resolveSafePath(config.dataPath, userPath);
      if (!safePath) return new Response("Invalid path", { status: 400 });
      return handleThumbnail(safePath);
    }

    return new Response("Not found", { status: 404 });
  },
});

logger.info("Init", "Starting OPDS Generator", {
  files: config.filesPath,
  data: config.dataPath,
  port: config.port,
  baseUrl: config.baseUrl,
  devMode: config.devMode
});

await mkdir(config.dataPath, { recursive: true });
await sync();
startWatcher();
logger.info("Server", `Listening on http://localhost:${server.port}`);
