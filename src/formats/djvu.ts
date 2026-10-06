import sharp from "sharp";
import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { logHandlerError } from "../logging/index.ts";
import { COVER_MAX_SIZE } from "../constants.ts";
import { join } from "node:path";
import { spawnWithTimeout, spawnWithTimeoutText, withTemporaryDirectory } from "../utils/process.ts";

interface DjvuMeta {
  title?: string;
  author?: string;
  keywords?: string;
  creationDate?: string;
  pages?: number;
}

function parseMetaValue(value: string): string {
  return value.replace(/^"(.*)"$/, "$1").trim();
}

async function parseDjvuMeta(filePath: string, signal?: AbortSignal): Promise<DjvuMeta | null> {
  const results = await Promise.allSettled([
    spawnWithTimeoutText({ command: ["djvused", filePath, "-e", "print-meta"], signal }),
    spawnWithTimeoutText({ command: ["djvused", filePath, "-e", "n"], signal }),
  ]);

  signal?.throwIfAborted();
  const [metaResult, pagesResult] = results;

  if (metaResult.status === "rejected") throw metaResult.reason;

  if (pagesResult.status === "rejected") throw pagesResult.reason;
  const { stdout: metaOutput, exitCode: metaExitCode } = metaResult.value;
  const { stdout: pagesOutput, exitCode: pagesExitCode } = pagesResult.value;

  if (metaExitCode !== 0 && pagesExitCode !== 0) return null;

  const meta: DjvuMeta = {};

  for (const line of metaOutput.split("\n")) {
    const tabIndex = line.indexOf("\t");

    if (tabIndex === -1) continue;

    const key = line.slice(0, tabIndex).trim();
    const value = parseMetaValue(line.slice(tabIndex + 1));

    if (!value) continue;

    switch (key) {
      case "Title":
        meta.title = value;
        break;
      case "Author":
        meta.author = value;
        break;
      case "Keywords":
        meta.keywords = value;
        break;
      case "CreationDate":
        meta.creationDate = value;
        break;
    }
  }

  if (pagesExitCode === 0) {
    const pages = parseInt(pagesOutput.trim(), 10);

    if (!isNaN(pages)) meta.pages = pages;
  }

  return meta;
}

function parseKeywords(keywords: string | undefined): string[] | undefined {
  if (!keywords) return undefined;

  const items = keywords
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

function parseCreationDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;

  const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);

  return yearMatch ? yearMatch[0] : undefined;
}

async function extractCover(filePath: string, signal?: AbortSignal): Promise<Buffer | null> {
  try {
    return await withTemporaryDirectory(
      "djvu-",
      async (tempDir) => {
        signal?.throwIfAborted();
        const tiffPath = join(tempDir, "page.tiff");

        const { exitCode: ddjvuExitCode } = await spawnWithTimeout({
          command: ["ddjvu", "-format=tiff", "-page=1", filePath, tiffPath],
          signal,
        });

        if (ddjvuExitCode !== 0) return null;

        const data = await sharp(tiffPath)
          .resize(COVER_MAX_SIZE, COVER_MAX_SIZE, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer();

        signal?.throwIfAborted();

        if (data.byteLength === 0) return null;

        return data;
      },
      signal,
    );
  } catch {
    signal?.throwIfAborted();

    return null;
  }
}

async function createDjvuHandler(filePath: string, signal?: AbortSignal): Promise<FormatHandler | null> {
  try {
    signal?.throwIfAborted();
    const file = Bun.file(filePath);

    if (!(await file.exists())) return null;

    const meta = await parseDjvuMeta(filePath, signal);

    if (!meta) return null;

    const metadata: BookMetadata = {
      title: meta.title || "",
      author: meta.author,
      issued: parseCreationDate(meta.creationDate),
      subjects: parseKeywords(meta.keywords),
      pageCount: meta.pages,
    };

    return {
      getMetadata() {
        return metadata;
      },

      async getCover() {
        return extractCover(filePath, signal);
      },
    };
  } catch (error) {
    signal?.throwIfAborted();
    logHandlerError("DJVU", filePath, error);

    return null;
  }
}

export const djvuHandlerRegistration: FormatHandlerRegistration = {
  extensions: ["djvu"],
  create: createDjvuHandler,
};
