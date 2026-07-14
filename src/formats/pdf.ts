import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { logHandlerError } from "../logging/index.ts";
import { COVER_MAX_SIZE } from "../constants.ts";

const SOURCE_FILE_EXTENSIONS = /\.(indd|qxd|docx?|odt|rtf|pages|tex|pub|wpd|fm)$/i;

interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creationDate?: string;
  pages?: number;
}

async function parsePdfInfo(filePath: string): Promise<PdfInfo | null> {
  const proc = Bun.spawn(["pdfinfo", filePath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  if (exitCode !== 0) return null;

  return parsePdfInfoOutput(output);
}

export function parsePdfInfoOutput(output: string): PdfInfo {
  const info: PdfInfo = {};
  const lines = output.split("\n");

  for (const line of lines) {
    // Indented lines belong to sub-blocks like "PDF subtype" whose own
    // Title (e.g. "ISO 15930 - ...") must not override the document title
    if (/^\s/.test(line)) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (!value) continue;

    switch (key) {
      case "Title":
        info.title = value;
        break;
      case "Author":
        info.author = value;
        break;
      case "Subject":
        info.subject = value;
        break;
      case "Keywords":
        info.keywords = value;
        break;
      case "CreationDate":
        info.creationDate = value;
        break;
      case "Pages":
        info.pages = parseInt(value, 10);
        break;
    }
  }

  return info;
}

export function stripSourceFileExtension(title: string): string {
  return title.replace(SOURCE_FILE_EXTENSIONS, "");
}

function parseCreationDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;

  const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
  return yearMatch ? yearMatch[0] : undefined;
}

function parseKeywords(keywords: string | undefined): string[] | undefined {
  if (!keywords) return undefined;

  const items = keywords
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

async function extractCover(filePath: string): Promise<Buffer | null> {
  const proc = Bun.spawn(["pdftoppm", "-jpeg", "-f", "1", "-l", "1", "-scale-to", String(COVER_MAX_SIZE), filePath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [data, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);

  if (exitCode !== 0 || data.byteLength === 0) return null;

  return Buffer.from(data);
}

async function createPdfHandler(filePath: string): Promise<FormatHandler | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;

    const info = await parsePdfInfo(filePath);
    if (!info) return null;

    const metadata: BookMetadata = {
      title: stripSourceFileExtension(info.title || ""),
      author: info.author,
      description: info.subject,
      issued: parseCreationDate(info.creationDate),
      subjects: parseKeywords(info.keywords),
      pageCount: info.pages && !isNaN(info.pages) ? info.pages : undefined,
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
    logHandlerError("PDF", filePath, error);
    return null;
  }
}

export const pdfHandlerRegistration: FormatHandlerRegistration = {
  extensions: ["pdf"],
  create: createPdfHandler,
};
