import { basename } from "node:path";
import type { FileInfo, BookMeta } from "./types.ts";
import { MIME_TYPES } from "./types.ts";

export function extractBasicMeta(file: FileInfo): BookMeta {
  const fileName = basename(file.relativePath);
  const title = fileName.replace(/\.[^.]+$/, "");
  const mimeType = MIME_TYPES[file.extension] ?? "application/octet-stream";

  return {
    title,
    format: file.extension.toUpperCase(),
    mimeType,
    filePath: file.relativePath,
    fileSize: file.size,
  };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
