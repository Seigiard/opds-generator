/**
 * Извлечение метаданных из EPUB файлов
 */

import { readZipEntry } from "./zip.ts";

export interface EpubMeta {
  title?: string;
  author?: string;
  description?: string;
  coverPath?: string;
}

/**
 * Извлекает метаданные из EPUB файла
 */
export async function extractEpubMeta(filePath: string): Promise<EpubMeta> {
  const result: EpubMeta = {};

  // 1. Читаем container.xml чтобы найти путь к content.opf
  const container = await readZipEntry(filePath, "META-INF/container.xml");
  if (!container) return result;

  const opfPath = parseRootfile(container);
  if (!opfPath) return result;

  // 2. Читаем content.opf
  const opf = await readZipEntry(filePath, opfPath);
  if (!opf) return result;

  // 3. Извлекаем метаданные
  result.title = parseXmlTag(opf, "dc:title");
  result.author = parseXmlTag(opf, "dc:creator");
  result.description = parseDescription(opf);
  result.coverPath = parseCoverPath(opf, opfPath);

  return result;
}

/**
 * Находит путь к content.opf из container.xml
 */
function parseRootfile(xml: string): string | null {
  // <rootfile full-path="OEBPS/content.opf" .../>
  const match = xml.match(/rootfile[^>]+full-path="([^"]+)"/);
  return match?.[1] ?? null;
}

/**
 * Извлекает содержимое XML тега
 */
function parseXmlTag(xml: string, tag: string): string | undefined {
  // Ищем <tag ...>content</tag>
  const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  const match = xml.match(regex);
  return match?.[1]?.trim();
}

/**
 * Извлекает description и очищает от HTML
 */
function parseDescription(xml: string): string | undefined {
  const raw = parseXmlTag(xml, "dc:description");
  if (!raw) return undefined;

  // Декодируем HTML entities и убираем теги
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, "") // убираем HTML теги
    .replace(/\s+/g, " ") // нормализуем пробелы
    .trim();
}

/**
 * Находит путь к обложке
 */
function parseCoverPath(opf: string, opfPath: string): string | undefined {
  // 1. Ищем <meta name="cover" content="cover-id"/>
  const coverMeta = opf.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/);
  if (!coverMeta) return undefined;

  const coverId = coverMeta[1];

  // 2. Ищем <item id="cover-id" href="path/to/cover.jpg"/>
  const itemRegex = new RegExp(`<item[^>]+id="${coverId}"[^>]+href="([^"]+)"`, "i");
  const itemMatch = opf.match(itemRegex);
  if (!itemMatch) return undefined;

  const coverHref = itemMatch[1];

  // 3. Путь относительно content.opf
  const opfDir = opfPath.replace(/[^/]+$/, ""); // убираем filename
  return opfDir + coverHref;
}
