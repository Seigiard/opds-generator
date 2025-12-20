import { basename } from "node:path";
import type { FileInfo, BookMeta } from "./types.ts";
import { MIME_TYPES } from "./types.ts";

/**
 * Извлекает базовые метаданные из имени файла.
 * Пытается распознать паттерны:
 * - "Автор - Название.epub"
 * - "Название (год).pdf"
 * - "Название.mobi"
 */
export function extractBasicMeta(file: FileInfo): BookMeta {
  const fileName = basename(file.relativePath);
  const nameWithoutExt = fileName.replace(/\.[^.]+$/, "");

  let title = nameWithoutExt;
  let author: string | undefined;

  // Паттерн: "Автор - Название"
  const dashMatch = nameWithoutExt.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    author = dashMatch[1]?.trim();
    title = dashMatch[2]?.trim() ?? title;
  }

  // Убираем год в скобках: "Название (2023)"
  title = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();

  // Убираем квадратные скобки с содержимым: "[FB2]", "[OCR]"
  title = title.replace(/\s*\[[^\]]+\]\s*/g, " ").trim();

  const mimeType = MIME_TYPES[file.extension] ?? "application/octet-stream";

  return {
    title: title || fileName,
    author,
    format: file.extension.toUpperCase(),
    mimeType,
    filePath: file.relativePath,
    fileSize: file.size,
  };
}

/**
 * Форматирует размер файла в человекочитаемый вид
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
