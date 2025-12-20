/**
 * Извлечение метаданных из CBZ/CBR файлов (комиксы)
 */

import { readZipEntry, listZipEntries } from "./zip.ts";

export interface CbzMeta {
  title?: string;
  author?: string;
  coverPath?: string;
}

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

/**
 * Извлекает метаданные из CBZ файла
 */
export async function extractCbzMeta(filePath: string): Promise<CbzMeta> {
  const result: CbzMeta = {};

  // 1. Пробуем найти ComicInfo.xml
  const comicInfo = await readZipEntry(filePath, "ComicInfo.xml");
  if (comicInfo) {
    result.title = parseXmlTag(comicInfo, "Title");
    result.author = parseXmlTag(comicInfo, "Writer");
  }

  // 2. Ищем первое изображение как обложку
  const entries = await listZipEntries(filePath);
  const images = entries
    .filter((e) => IMAGE_EXTENSIONS.some((ext) => e.toLowerCase().endsWith(ext)))
    .sort();

  if (images.length > 0) {
    result.coverPath = images[0];
  }

  return result;
}

/**
 * Извлекает содержимое XML тега
 */
function parseXmlTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  const match = xml.match(regex);
  return match?.[1]?.trim();
}
