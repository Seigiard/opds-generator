import type { BookMeta, FolderInfo } from "./types.ts";
import { formatFileSize } from "./metadata.ts";

const OPDS_NS = "http://www.w3.org/2005/Atom";
const DC_NS = "http://purl.org/dc/terms/";
const OPDS_SPEC = "http://opds-spec.org";

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function timestamp(): string {
  return new Date().toISOString();
}

function feedId(path: string): string {
  return `urn:opds:catalog:${path || "root"}`;
}

interface NavigationEntry {
  title: string;
  href: string;
  count?: number;
}

export function buildNavigationFeed(
  title: string,
  path: string,
  entries: NavigationEntry[],
  baseUrl: string
): string {
  const selfHref = path ? `${baseUrl}/opds/${encodeUrlPath(path)}` : `${baseUrl}/opds`;
  const updated = timestamp();

  const entriesXml = entries
    .map(
      (entry) => `  <entry>
    <title>${escapeXml(entry.title)}</title>
    <id>${feedId(entry.href)}</id>
    <updated>${updated}</updated>
    <link rel="subsection"
          href="${baseUrl}/opds/${encodeUrlPath(entry.href)}"
          type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
    ${entry.count !== undefined ? `<content type="text">${entry.count} books</content>` : ""}
  </entry>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="${OPDS_NS}" xmlns:dc="${DC_NS}">
  <id>${feedId(path)}</id>
  <title>${escapeXml(title)}</title>
  <updated>${updated}</updated>
  <link rel="self" href="${selfHref}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${baseUrl}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
${entriesXml}
</feed>`;
}

export function buildAcquisitionFeed(
  title: string,
  path: string,
  books: BookMeta[],
  baseUrl: string
): string {
  const selfHref = `${baseUrl}/opds/${encodeUrlPath(path)}`;
  const updated = timestamp();

  const entriesXml = books
    .map(
      (book) => `  <entry>
    <title>${escapeXml(book.title)}</title>
    <id>urn:opds:book:${escapeXml(book.filePath)}</id>
    <updated>${updated}</updated>${book.author ? `
    <author><name>${escapeXml(book.author)}</name></author>` : ""}${book.description ? `
    <summary>${escapeXml(book.description)}</summary>` : ""}
    <dc:format>${escapeXml(book.format)}</dc:format>
    <content type="text">${formatFileSize(book.fileSize)}</content>
    <link rel="${OPDS_SPEC}/image"
          href="${baseUrl}/cover/${encodeUrlPath(book.filePath)}"
          type="image/jpeg"/>
    <link rel="${OPDS_SPEC}/image/thumbnail"
          href="${baseUrl}/cover/${encodeUrlPath(book.filePath)}"
          type="image/jpeg"/>
    <link rel="${OPDS_SPEC}/acquisition"
          href="${baseUrl}/download/${encodeUrlPath(book.filePath)}"
          type="${book.mimeType}"/>
  </entry>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="${OPDS_NS}" xmlns:dc="${DC_NS}">
  <id>${feedId(path)}</id>
  <title>${escapeXml(title)}</title>
  <updated>${updated}</updated>
  <link rel="self" href="${selfHref}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="start" href="${baseUrl}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
${entriesXml}
</feed>`;
}

export function buildMixedFeed(
  title: string,
  path: string,
  subfolders: NavigationEntry[],
  books: BookMeta[],
  baseUrl: string
): string {
  const selfHref = path ? `${baseUrl}/opds/${encodeUrlPath(path)}` : `${baseUrl}/opds`;
  const updated = timestamp();

  const folderEntriesXml = subfolders
    .map(
      (entry) => `  <entry>
    <title>${escapeXml(entry.title)}</title>
    <id>${feedId(entry.href)}</id>
    <updated>${updated}</updated>
    <link rel="subsection"
          href="${baseUrl}/opds/${encodeUrlPath(entry.href)}"
          type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
    ${entry.count !== undefined ? `<content type="text">${entry.count} books</content>` : ""}
  </entry>`
    )
    .join("\n");

  const bookEntriesXml = books
    .map(
      (book) => `  <entry>
    <title>${escapeXml(book.title)}</title>
    <id>urn:opds:book:${escapeXml(book.filePath)}</id>
    <updated>${updated}</updated>${book.author ? `
    <author><name>${escapeXml(book.author)}</name></author>` : ""}${book.description ? `
    <summary>${escapeXml(book.description)}</summary>` : ""}
    <dc:format>${escapeXml(book.format)}</dc:format>
    <content type="text">${formatFileSize(book.fileSize)}</content>
    <link rel="${OPDS_SPEC}/image"
          href="${baseUrl}/cover/${encodeUrlPath(book.filePath)}"
          type="image/jpeg"/>
    <link rel="${OPDS_SPEC}/image/thumbnail"
          href="${baseUrl}/cover/${encodeUrlPath(book.filePath)}"
          type="image/jpeg"/>
    <link rel="${OPDS_SPEC}/acquisition"
          href="${baseUrl}/download/${encodeUrlPath(book.filePath)}"
          type="${book.mimeType}"/>
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
  <link rel="self" href="${selfHref}" type="application/atom+xml;profile=opds-catalog;kind=${kind}"/>
  <link rel="start" href="${baseUrl}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
${folderEntriesXml}
${bookEntriesXml}
</feed>`;
}

export function pathToFilename(path: string): string {
  if (!path) return "root.xml";
  return path.replace(/\//g, "--") + ".xml";
}

export function filenameToPath(filename: string): string {
  if (filename === "root.xml") return "";
  return filename.replace(/\.xml$/, "").replace(/--/g, "/");
}
