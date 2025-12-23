import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { logHandlerError } from "../utils/errors.ts";
import { COVER_MAX_SIZE } from "../constants.ts";

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

async function parseDjvuMeta(filePath: string): Promise<DjvuMeta | null> {
  const metaProc = Bun.spawn(["djvused", filePath, "-e", "print-meta"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const pagesProc = Bun.spawn(["djvused", filePath, "-e", "n"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [metaOutput, metaExitCode, pagesOutput, pagesExitCode] = await Promise.all([
    new Response(metaProc.stdout).text(),
    metaProc.exited,
    new Response(pagesProc.stdout).text(),
    pagesProc.exited,
  ]);

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

async function extractCover(filePath: string): Promise<Buffer | null> {
  const ddjvu = Bun.spawn(["ddjvu", "-format=ppm", "-page=1", filePath, "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const convert = Bun.spawn(
    ["convert", "ppm:-", "-resize", `${COVER_MAX_SIZE}x${COVER_MAX_SIZE}>`, "jpeg:-"],
    {
      stdin: ddjvu.stdout,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const [data, exitCode] = await Promise.all([
    new Response(convert.stdout).arrayBuffer(),
    convert.exited,
  ]);

  await ddjvu.exited;

  if (exitCode !== 0 || data.byteLength === 0) return null;

  return Buffer.from(data);
}

async function createDjvuHandler(filePath: string): Promise<FormatHandler | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;

    const meta = await parseDjvuMeta(filePath);
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
        return extractCover(filePath);
      },
    };
  } catch (error) {
    logHandlerError("DJVU", filePath, error);
    return null;
  }
}

export const djvuHandlerRegistration: FormatHandlerRegistration = {
  extensions: ["djvu"],
  create: createDjvuHandler,
};
