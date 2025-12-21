import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, basename, extname, normalize, isAbsolute } from "node:path";
import { scanDirectory, buildFolderStructure, computeHash, computeFileHash } from "./scanner.ts";
import { readManifest, writeManifest, createManifest } from "./manifest.ts";
import {
  extractBasicMeta,
  extractCoverLazy,
  listCachedMeta,
  writeCachedMeta,
  deleteCachedMeta,
  getCoverPath,
  getThumbnailPath,
} from "./metadata.ts";
import { buildMixedFeed, pathToFilename } from "./opds.ts";
import type { FolderInfo, BookMeta } from "./types.ts";
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
let folders: FolderInfo[] = [];
let booksByFolder: Map<string, BookMeta[]> = new Map();
let isRebuilding = false;
let rebuildTimer: Timer | null = null;

async function generateFeeds(): Promise<void> {
  const opdsPath = join(DATA_PATH, "opds");
  await mkdir(opdsPath, { recursive: true });

  for (const folder of folders) {
    const subfolderEntries = folder.subfolders.map((sf) => {
      const subFolder = folders.find((f) => f.path === sf);
      const bookCount = countBooksRecursive(sf);
      return {
        title: subFolder?.name || basename(sf),
        href: sf,
        count: bookCount,
      };
    });

    const books = booksByFolder.get(folder.path) || [];
    const title = folder.name || "Catalog";
    const xml = buildMixedFeed(title, folder.path, subfolderEntries, books, BASE_URL);
    const filename = pathToFilename(folder.path);

    await Bun.write(join(opdsPath, filename), xml);
  }

  console.log(`[OPDS] Generated ${folders.length} feeds`);
}

function countBooksRecursive(folderPath: string): number {
  let count = booksByFolder.get(folderPath)?.length || 0;

  for (const folder of folders) {
    if (folder.path.startsWith(folderPath + "/")) {
      count += booksByFolder.get(folder.path)?.length || 0;
    }
  }

  return count;
}

async function rebuild(): Promise<void> {
  if (isRebuilding) return;
  isRebuilding = true;

  console.log("[Rebuild] Starting...");
  const startTime = Date.now();

  try {
    const files = await scanDirectory(FILES_PATH);
    console.log(`[Rebuild] Found ${files.length} books`);

    const cached = await listCachedMeta(DATA_PATH);
    console.log(`[Rebuild] Cached: ${cached.size} entries`);

    const currentPaths = new Set(files.map((f) => f.relativePath));
    const cachedPaths = new Set(cached.keys());

    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];

    for (const file of files) {
      const cachedMeta = cached.get(file.relativePath);
      if (!cachedMeta) {
        added.push(file.relativePath);
      } else {
        const newHash = computeFileHash(file);
        if (cachedMeta.hash !== newHash) {
          changed.push(file.relativePath);
        }
      }
    }

    for (const path of cachedPaths) {
      if (!currentPaths.has(path)) {
        removed.push(path);
      }
    }

    console.log(
      `[Rebuild] Changes: +${added.length} ~${changed.length} -${removed.length}`
    );

    for (const path of removed) {
      await deleteCachedMeta(DATA_PATH, path);
      cached.delete(path);
    }

    for (const path of [...added, ...changed]) {
      const file = files.find((f) => f.relativePath === path)!;
      const meta = await extractBasicMeta(file);
      await writeCachedMeta(DATA_PATH, path, meta);
      cached.set(path, meta);
    }

    currentHash = computeHash(files);
    console.log(`[Rebuild] Hash: ${currentHash}`);

    folders = buildFolderStructure(FILES_PATH, files);
    console.log(`[Rebuild] Found ${folders.length} folders`);

    booksByFolder = new Map();
    for (const meta of cached.values()) {
      const folderPath = meta.filePath.split("/").slice(0, -1).join("/");
      if (!booksByFolder.has(folderPath)) {
        booksByFolder.set(folderPath, []);
      }
      booksByFolder.get(folderPath)!.push(meta);
    }

    await generateFeeds();

    const manifest = createManifest(files, currentHash);
    await writeManifest(DATA_PATH, manifest);

    const duration = Date.now() - startTime;
    console.log(`[Rebuild] Complete in ${duration}ms`);
  } catch (error) {
    console.error("[Rebuild] Error:", error);
  } finally {
    isRebuilding = false;
  }
}

async function hydrateFromCache(): Promise<boolean> {
  const cached = await listCachedMeta(DATA_PATH);
  if (cached.size === 0) return false;

  booksByFolder = new Map();
  for (const meta of cached.values()) {
    const folderPath = meta.filePath.split("/").slice(0, -1).join("/");
    if (!booksByFolder.has(folderPath)) {
      booksByFolder.set(folderPath, []);
    }
    booksByFolder.get(folderPath)!.push(meta);
  }

  const folderPaths = new Set<string>();
  for (const p of booksByFolder.keys()) {
    folderPaths.add(p);
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      folderPaths.add(parts.slice(0, i).join("/"));
    }
  }
  folderPaths.add("");

  folders = Array.from(folderPaths).map((p) => ({
    path: p,
    name: p.split("/").pop() || "Catalog",
    subfolders: Array.from(folderPaths).filter(
      (f) =>
        f.startsWith(p ? p + "/" : "") &&
        f.split("/").length === (p ? p.split("/").length + 1 : 1)
    ),
  }));

  console.log(`[Hydrate] Loaded ${cached.size} books, ${folders.length} folders`);
  return true;
}

function isBookFile(filename: string): boolean {
  const ext = extname(filename).slice(1).toLowerCase();
  return BOOK_EXTENSIONS.includes(ext);
}

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuild();
    rebuildTimer = null;
  }, 500);
}

function startWatcher(): void {
  watch(FILES_PATH, { recursive: true }, (event, filename) => {
    if (filename && isBookFile(filename)) {
      console.log(`[Watch] ${event}: ${filename}`);
      scheduleRebuild();
    }
  });
  console.log(`[Watch] Watching ${FILES_PATH}`);
}

async function handleOpds(feedPath: string, req: Request): Promise<Response> {
  const filename = pathToFilename(feedPath);
  const file = Bun.file(join(DATA_PATH, "opds", filename));

  if (await file.exists()) {
    const etag = DEV_MODE
      ? `"dev-${Date.now()}"`
      : `"${currentHash}-${file.lastModified}"`;
    const lastModified = new Date(file.lastModified).toUTCString();
    const ifNoneMatch = req.headers.get("If-None-Match");

    if (!DEV_MODE && ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(file, {
      headers: {
        "Content-Type": "application/atom+xml;charset=utf-8",
        "ETag": etag,
        "Last-Modified": lastModified,
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

const PLACEHOLDER_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x78, 0x78, 0x78, 0x00,
  0x00, 0x02, 0x3d, 0x01, 0x26, 0xf8, 0x7e, 0xb1, 0xa8, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function findBookMeta(filePath: string): BookMeta | undefined {
  const folderPath = filePath.split("/").slice(0, -1).join("/");
  const books = booksByFolder.get(folderPath);
  return books?.find((b) => b.filePath === filePath);
}

const imageCacheControl = DEV_MODE ? "no-store" : "public, max-age=31536000";
const placeholderCacheControl = DEV_MODE ? "no-store" : "public, max-age=3600";

async function handleCover(filePath: string): Promise<Response> {
  const coverPath = getCoverPath(filePath, DATA_PATH);
  const coverFile = Bun.file(coverPath);

  if (await coverFile.exists()) {
    return new Response(coverFile, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": imageCacheControl,
      },
    });
  }

  const meta = findBookMeta(filePath);
  if (meta) {
    const extracted = await extractCoverLazy(meta, FILES_PATH, DATA_PATH);
    if (extracted) {
      return new Response(Bun.file(coverPath), {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": imageCacheControl,
        },
      });
    }
  }

  return new Response(PLACEHOLDER_PNG, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": placeholderCacheControl,
    },
  });
}

async function handleThumbnail(filePath: string): Promise<Response> {
  const thumbnailPath = getThumbnailPath(filePath, DATA_PATH);
  const thumbnailFile = Bun.file(thumbnailPath);

  if (await thumbnailFile.exists()) {
    return new Response(thumbnailFile, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": imageCacheControl,
      },
    });
  }

  const meta = findBookMeta(filePath);
  if (meta) {
    const extracted = await extractCoverLazy(meta, FILES_PATH, DATA_PATH);
    if (extracted) {
      return new Response(Bun.file(thumbnailPath), {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": imageCacheControl,
        },
      });
    }
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
      const bookCount = Array.from(booksByFolder.values()).reduce(
        (sum, books) => sum + books.length,
        0
      );
      return Response.json({
        status: isRebuilding ? "rebuilding" : "ready",
        books: bookCount,
        folders: folders.length,
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
await mkdir(join(DATA_PATH, "opds"), { recursive: true });
await mkdir(join(DATA_PATH, "covers"), { recursive: true });
await mkdir(join(DATA_PATH, "thumbnails"), { recursive: true });
await mkdir(join(DATA_PATH, "raw"), { recursive: true });

const oldManifest = await readManifest(DATA_PATH);
if (oldManifest) {
  currentHash = oldManifest.hash;
  console.log(`[Init] Found existing manifest, hash: ${currentHash}`);
}

const hydrated = await hydrateFromCache();
if (hydrated) {
  console.log(`[Server] Listening on http://localhost:${server.port}`);
  startWatcher();
  rebuild();
} else {
  await rebuild();
  startWatcher();
  console.log(`[Server] Listening on http://localhost:${server.port}`);
}
