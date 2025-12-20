import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { scanDirectory, buildFolderStructure, computeHash } from "./scanner.ts";
import { readManifest, writeManifest, createManifest, needsRebuild } from "./manifest.ts";
import { extractBasicMeta } from "./metadata.ts";
import { buildMixedFeed, pathToFilename, filenameToPath } from "./opds.ts";
import type { FileInfo, FolderInfo, BookMeta } from "./types.ts";

// Конфигурация из env
const FILES_PATH = process.env.FILES || "./files";
const DATA_PATH = process.env.DATA || "./data";
const PORT = parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Состояние приложения
let currentHash = "";
let folders: FolderInfo[] = [];
let booksByFolder: Map<string, BookMeta[]> = new Map();
let isRebuilding = false;

/**
 * Генерирует и сохраняет все OPDS фиды
 */
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

    await writeFile(join(opdsPath, filename), xml);
  }

  console.log(`[OPDS] Generated ${folders.length} feeds`);
}

/**
 * Считает книги рекурсивно в папке
 */
function countBooksRecursive(folderPath: string): number {
  let count = booksByFolder.get(folderPath)?.length || 0;

  for (const folder of folders) {
    if (folder.path.startsWith(folderPath + "/")) {
      count += booksByFolder.get(folder.path)?.length || 0;
    }
  }

  return count;
}

/**
 * Полный ребилд каталога
 */
async function rebuild(): Promise<void> {
  if (isRebuilding) return;
  isRebuilding = true;

  console.log("[Rebuild] Starting...");
  const startTime = Date.now();

  try {
    // 1. Сканируем директорию
    const files = await scanDirectory(FILES_PATH);
    console.log(`[Rebuild] Found ${files.length} books`);

    // 2. Вычисляем хэш
    currentHash = computeHash(files);
    console.log(`[Rebuild] Hash: ${currentHash}`);

    // 3. Строим структуру папок
    folders = buildFolderStructure(FILES_PATH, files);
    console.log(`[Rebuild] Found ${folders.length} folders`);

    // 4. Извлекаем метаданные и группируем по папкам
    booksByFolder = new Map();
    for (const file of files) {
      const folderPath = file.relativePath.split("/").slice(0, -1).join("/");
      const meta = extractBasicMeta(file);

      if (!booksByFolder.has(folderPath)) {
        booksByFolder.set(folderPath, []);
      }
      booksByFolder.get(folderPath)!.push(meta);
    }

    // 5. Генерируем OPDS фиды
    await generateFeeds();

    // 6. Сохраняем манифест
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

/**
 * Проверяет нужен ли ребилд и запускает его асинхронно
 */
async function checkAndRebuild(): Promise<void> {
  try {
    const files = await scanDirectory(FILES_PATH);
    const newHash = computeHash(files);

    if (newHash !== currentHash) {
      console.log("[Check] Hash changed, triggering rebuild");
      rebuild(); // Асинхронно, не ждём
    }
  } catch (error) {
    console.error("[Check] Error:", error);
  }
}

/**
 * Обработка HTTP запросов
 */
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // OPDS каталог
  if (path === "/opds" || path.startsWith("/opds/")) {
    // Проверяем изменения асинхронно
    checkAndRebuild();

    const feedPath = path === "/opds" ? "" : path.slice(6); // убираем "/opds/"
    const filename = pathToFilename(feedPath);
    const filePath = join(DATA_PATH, "opds", filename);

    try {
      const content = await readFile(filePath, "utf-8");

      return new Response(content, {
        headers: {
          "Content-Type": "application/atom+xml;charset=utf-8",
          "ETag": `"${currentHash}"`,
          "Cache-Control": "public, max-age=60",
        },
      });
    } catch {
      return new Response("Feed not found", { status: 404 });
    }
  }

  // Скачивание файла
  if (path.startsWith("/download/")) {
    const filePath = decodeURIComponent(path.slice(10)); // убираем "/download/"
    const fullPath = join(FILES_PATH, filePath);

    const file = Bun.file(fullPath);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "Content-Disposition": `attachment; filename="${basename(filePath)}"`,
        },
      });
    }

    return new Response("File not found", { status: 404 });
  }

  // Корень — редирект на /opds
  if (path === "/") {
    return Response.redirect(`${BASE_URL}/opds`, 302);
  }

  return new Response("Not found", { status: 404 });
}

/**
 * Инициализация и запуск
 */
async function main(): Promise<void> {
  console.log(`[Init] FILES: ${FILES_PATH}`);
  console.log(`[Init] DATA: ${DATA_PATH}`);
  console.log(`[Init] PORT: ${PORT}`);
  console.log(`[Init] BASE_URL: ${BASE_URL}`);

  // Создаём директории
  await mkdir(DATA_PATH, { recursive: true });
  await mkdir(join(DATA_PATH, "opds"), { recursive: true });

  // Проверяем манифест
  const oldManifest = await readManifest(DATA_PATH);

  if (oldManifest) {
    currentHash = oldManifest.hash;
    console.log(`[Init] Found existing manifest, hash: ${currentHash}`);
  }

  // Первоначальный ребилд (блокирующий при первом запуске)
  await rebuild();

  // Запускаем HTTP сервер
  const server = Bun.serve({
    port: PORT,
    fetch: handleRequest,
  });

  console.log(`[Server] Listening on http://localhost:${server.port}`);
}

main().catch(console.error);
