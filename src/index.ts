import { mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { scanDirectory, buildFolderStructure, computeHash } from "./scanner.ts";
import { readManifest, writeManifest, createManifest } from "./manifest.ts";
import { extractBasicMeta } from "./metadata.ts";
import { buildMixedFeed, pathToFilename } from "./opds.ts";
import type { FolderInfo, BookMeta } from "./types.ts";

const FILES_PATH = process.env.FILES || "./files";
const DATA_PATH = process.env.DATA || "./data";
const PORT = parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

let currentHash = "";
let folders: FolderInfo[] = [];
let booksByFolder: Map<string, BookMeta[]> = new Map();
let isRebuilding = false;

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
    const title = folder.name || "Каталог";
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

    currentHash = computeHash(files);
    console.log(`[Rebuild] Hash: ${currentHash}`);

    folders = buildFolderStructure(FILES_PATH, files);
    console.log(`[Rebuild] Found ${folders.length} folders`);

    booksByFolder = new Map();
    for (const file of files) {
      const folderPath = file.relativePath.split("/").slice(0, -1).join("/");
      const meta = extractBasicMeta(file);

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

async function checkAndRebuild(): Promise<void> {
  try {
    const files = await scanDirectory(FILES_PATH);
    const newHash = computeHash(files);

    if (newHash !== currentHash) {
      console.log("[Check] Hash changed, triggering rebuild");
      rebuild();
    }
  } catch (error) {
    console.error("[Check] Error:", error);
  }
}

async function handleOpds(feedPath: string): Promise<Response> {
  checkAndRebuild();

  const filename = pathToFilename(feedPath);
  const file = Bun.file(join(DATA_PATH, "opds", filename));

  if (await file.exists()) {
    return new Response(file, {
      headers: {
        "Content-Type": "application/atom+xml;charset=utf-8",
        "ETag": `"${currentHash}"`,
        "Cache-Control": "public, max-age=60",
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

const server = Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") {
      return Response.redirect(`${BASE_URL}/opds`, 302);
    }

    if (path === "/opds" || path.startsWith("/opds/")) {
      const feedPath = path === "/opds" ? "" : path.slice(6);
      return handleOpds(feedPath);
    }

    if (path.startsWith("/download/")) {
      const filePath = decodeURIComponent(path.slice(10));
      return handleDownload(filePath);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[Init] FILES: ${FILES_PATH}`);
console.log(`[Init] DATA: ${DATA_PATH}`);
console.log(`[Init] PORT: ${PORT}`);
console.log(`[Init] BASE_URL: ${BASE_URL}`);

await mkdir(DATA_PATH, { recursive: true });
await mkdir(join(DATA_PATH, "opds"), { recursive: true });

const oldManifest = await readManifest(DATA_PATH);
if (oldManifest) {
  currentHash = oldManifest.hash;
  console.log(`[Init] Found existing manifest, hash: ${currentHash}`);
}

await rebuild();
console.log(`[Server] Listening on http://localhost:${server.port}`);
