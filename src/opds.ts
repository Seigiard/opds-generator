import type { BookMeta, FolderInfo } from "./types.ts";
import { formatFileSize } from "./metadata.ts";

const OPDS_NS = "http://www.w3.org/2005/Atom";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const OPDS_SPEC = "http://opds-spec.org";

/**
 * Экранирует спецсимволы для XML
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Генерирует ISO 8601 timestamp
 */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Генерирует уникальный ID для фида
 */
function feedId(path: string): string {
  return `urn:opds:catalog:${path || "root"}`;
}

interface NavigationEntry {
  title: string;
  href: string;
  count?: number;
}

/**
 * Генерирует Navigation Feed (список папок)
 */
export function buildNavigationFeed(
  title: string,
  path: string,
  entries: NavigationEntry[],
  baseUrl: string
): string {
  const selfHref = path ? `${baseUrl}/opds/${path}` : `${baseUrl}/opds`;
  const updated = timestamp();

  const entriesXml = entries
    .map(
      (entry) => `  <entry>
    <title>${escapeXml(entry.title)}</title>
    <id>${feedId(entry.href)}</id>
    <updated>${updated}</updated>
    <link rel="subsection"
          href="${escapeXml(baseUrl)}/opds/${escapeXml(entry.href)}"
          type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
    ${entry.count !== undefined ? `<content type="text">${entry.count} книг</content>` : ""}
  </entry>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="${OPDS_NS}" xmlns:dc="${DC_NS}">
  <id>${feedId(path)}</id>
  <title>${escapeXml(title)}</title>
  <updated>${updated}</updated>
  <link rel="self" href="${escapeXml(selfHref)}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${escapeXml(baseUrl)}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
${entriesXml}
</feed>`;
}

/**
 * Генерирует Acquisition Feed (список книг)
 */
export function buildAcquisitionFeed(
  title: string,
  path: string,
  books: BookMeta[],
  baseUrl: string
): string {
  const selfHref = `${baseUrl}/opds/${path}`;
  const updated = timestamp();

  const entriesXml = books
    .map(
      (book) => `  <entry>
    <title>${escapeXml(book.title)}</title>
    <id>urn:opds:book:${escapeXml(book.filePath)}</id>
    <updated>${updated}</updated>
    <dc:format>${escapeXml(book.format)}</dc:format>
    <content type="text">${formatFileSize(book.fileSize)}</content>
    <link rel="${OPDS_SPEC}/acquisition/open-access"
          href="${escapeXml(baseUrl)}/download/${escapeXml(book.filePath)}"
          type="${escapeXml(book.mimeType)}"/>
  </entry>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="${OPDS_NS}" xmlns:dc="${DC_NS}">
  <id>${feedId(path)}</id>
  <title>${escapeXml(title)}</title>
  <updated>${updated}</updated>
  <link rel="self" href="${escapeXml(selfHref)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="start" href="${escapeXml(baseUrl)}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
${entriesXml}
</feed>`;
}

/**
 * Генерирует смешанный фид (папки + книги)
 */
export function buildMixedFeed(
  title: string,
  path: string,
  subfolders: NavigationEntry[],
  books: BookMeta[],
  baseUrl: string
): string {
  const selfHref = path ? `${baseUrl}/opds/${path}` : `${baseUrl}/opds`;
  const updated = timestamp();

  // Navigation entries для подпапок
  const folderEntriesXml = subfolders
    .map(
      (entry) => `  <entry>
    <title>${escapeXml(entry.title)}</title>
    <id>${feedId(entry.href)}</id>
    <updated>${updated}</updated>
    <link rel="subsection"
          href="${escapeXml(baseUrl)}/opds/${escapeXml(entry.href)}"
          type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
    ${entry.count !== undefined ? `<content type="text">${entry.count} книг</content>` : ""}
  </entry>`
    )
    .join("\n");

  // Acquisition entries для книг
  const bookEntriesXml = books
    .map(
      (book) => `  <entry>
    <title>${escapeXml(book.title)}</title>
    <id>urn:opds:book:${escapeXml(book.filePath)}</id>
    <updated>${updated}</updated>
    <dc:format>${escapeXml(book.format)}</dc:format>
    <content type="text">${formatFileSize(book.fileSize)}</content>
    <link rel="${OPDS_SPEC}/acquisition/open-access"
          href="${escapeXml(baseUrl)}/download/${escapeXml(book.filePath)}"
          type="${escapeXml(book.mimeType)}"/>
  </entry>`
    )
    .join("\n");

  const kind =
    subfolders.length > 0 && books.length === 0 ? "navigation" : "acquisition";

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="${OPDS_NS}" xmlns:dc="${DC_NS}">
  <id>${feedId(path)}</id>
  <title>${escapeXml(title)}</title>
  <updated>${updated}</updated>
  <link rel="self" href="${escapeXml(selfHref)}" type="application/atom+xml;profile=opds-catalog;kind=${kind}"/>
  <link rel="start" href="${escapeXml(baseUrl)}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
${folderEntriesXml}
${bookEntriesXml}
</feed>`;
}

/**
 * Преобразует путь папки в имя файла для кэша
 * "fiction/scifi" → "fiction--scifi.xml"
 */
export function pathToFilename(path: string): string {
  if (!path) return "root.xml";
  return path.replace(/\//g, "--") + ".xml";
}

/**
 * Преобразует имя файла обратно в путь
 * "fiction--scifi.xml" → "fiction/scifi"
 */
export function filenameToPath(filename: string): string {
  if (filename === "root.xml") return "";
  return filename.replace(/\.xml$/, "").replace(/--/g, "/");
}
