import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, basename, extname, normalize, isAbsolute } from "node:path";
import { scanFiles, createSyncPlan, computeHash } from "./scanner.ts";
import { processBook, processFolder, cleanupOrphan } from "./processor.ts";
import { buildFeed } from "./opds.ts";
import { BOOK_EXTENSIONS } from "./types.ts";

const FILES_PATH = process.env.FILES || "./files";
const DATA_PATH = process.env.DATA || "./data";
const PORT = parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DEV_MODE = process.env.DEV_MODE === "true";

function sanitizePath(userPath: string): string | null {
  const normalized = normalize(userPath);
  if (normalized.startsWith("..") || isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

let currentHash = "";
let isRebuilding = false;
let rebuildTimer: Timer | null = null;
let bookCount = 0;
let folderCount = 0;

async function sync(): Promise<void> {
  if (isRebuilding) return;
  isRebuilding = true;

  console.log("[Sync] Starting...");
  const startTime = Date.now();

  try {
    const files = await scanFiles(FILES_PATH);
    console.log(`[Sync] Found ${files.length} books in /files`);

    const plan = await createSyncPlan(files, DATA_PATH);
    console.log(
      `[Sync] Plan: +${plan.toProcess.length} process, -${plan.toDelete.length} delete`
    );

    for (const path of plan.toDelete) {
      await cleanupOrphan(DATA_PATH, path);
      console.log(`[Sync] Deleted: ${path}`);
    }

    for (const folder of plan.folders) {
      await processFolder(folder.path, DATA_PATH, BASE_URL);
    }
    console.log(`[Sync] Processed ${plan.folders.length} folders`);

    for (const file of plan.toProcess) {
      console.log(`[Sync] Processing: ${file.relativePath}`);
      await processBook(file, FILES_PATH, DATA_PATH);
    }

    currentHash = computeHash(files);
    bookCount = files.length;
    folderCount = plan.folders.length;

    const duration = Date.now() - startTime;
    console.log(`[Sync] Complete in ${duration}ms, hash: ${currentHash}`);
  } catch (error) {
    console.error("[Sync] Error:", error);
  } finally {
    isRebuilding = false;
  }
}

function isBookFile(filename: string): boolean {
  const ext = extname(filename).slice(1).toLowerCase();
  return BOOK_EXTENSIONS.includes(ext);
}

function scheduleSync(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    sync();
    rebuildTimer = null;
  }, 500);
}

function startWatcher(): void {
  watch(FILES_PATH, { recursive: true }, (event, filename) => {
    if (filename && isBookFile(filename)) {
      console.log(`[Watch] ${event}: ${filename}`);
      scheduleSync();
    }
  });
  console.log(`[Watch] Watching ${FILES_PATH}`);
}

const PLACEHOLDER_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x78, 0x78, 0x78, 0x00,
  0x00, 0x02, 0x3d, 0x01, 0x26, 0xf8, 0x7e, 0xb1, 0xa8, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const imageCacheControl = DEV_MODE ? "no-store" : "public, max-age=31536000";
const placeholderCacheControl = DEV_MODE ? "no-store" : "public, max-age=3600";

async function handleOpds(feedPath: string, req: Request): Promise<Response> {
  const feed = await buildFeed(feedPath, DATA_PATH);

  if (feed) {
    const etag = DEV_MODE
      ? `"dev-${Date.now()}"`
      : `"${currentHash}-${feedPath}"`;
    const ifNoneMatch = req.headers.get("If-None-Match");

    if (!DEV_MODE && ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(feed, {
      headers: {
        "Content-Type": "application/atom+xml;charset=utf-8",
        "ETag": etag,
        "Cache-Control": DEV_MODE ? "no-store" : "no-cache",
      },
    });
  }

  return new Response("Feed not found", { status: 404 });
}

async function handleDownload(filePath: string): Promise<Response> {
  const file = Bun.file(join(FILES_PATH, filePath));

  if (await file.exists()) {
    return new Response(file, {
      headers: {
        "Content-Disposition": `attachment; filename="${basename(filePath)}"`,
      },
    });
  }

  return new Response("File not found", { status: 404 });
}

async function handleCover(filePath: string): Promise<Response> {
  const coverPath = join(DATA_PATH, filePath, "cover.jpg");
  const coverFile = Bun.file(coverPath);

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

async function handleThumbnail(filePath: string): Promise<Response> {
  const thumbPath = join(DATA_PATH, filePath, "thumb.jpg");
  const thumbFile = Bun.file(thumbPath);

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
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") {
      return Response.redirect(`${BASE_URL}/opds`, 302);
    }

    if (path === "/health") {
      return Response.json({
        status: isRebuilding ? "rebuilding" : "ready",
        books: bookCount,
        folders: folderCount,
        hash: currentHash,
      });
    }

    if (path === "/opds" || path.startsWith("/opds/")) {
      const feedPath = path === "/opds" ? "" : sanitizePath(decodeURIComponent(path.slice(6)));
      if (feedPath === null) return new Response("Invalid path", { status: 400 });
      return handleOpds(feedPath, req);
    }

    if (path.startsWith("/download/")) {
      const filePath = sanitizePath(decodeURIComponent(path.slice(10)));
      if (!filePath) return new Response("Invalid path", { status: 400 });
      return handleDownload(filePath);
    }

    if (path.startsWith("/cover/")) {
      const filePath = sanitizePath(decodeURIComponent(path.slice(7)));
      if (!filePath) return new Response("Invalid path", { status: 400 });
      return handleCover(filePath);
    }

    if (path.startsWith("/thumbnail/")) {
      const filePath = sanitizePath(decodeURIComponent(path.slice(11)));
      if (!filePath) return new Response("Invalid path", { status: 400 });
      return handleThumbnail(filePath);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[Init] FILES: ${FILES_PATH}`);
console.log(`[Init] DATA: ${DATA_PATH}`);
console.log(`[Init] PORT: ${PORT}`);
console.log(`[Init] BASE_URL: ${BASE_URL}`);
if (DEV_MODE) console.log(`[Init] DEV_MODE: enabled (no caching)`);

await mkdir(DATA_PATH, { recursive: true });
await sync();
startWatcher();
console.log(`[Server] Listening on http://localhost:${server.port}`);
