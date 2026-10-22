import { basename } from "node:path";
import { Entry } from "opds-ts/v1.2";
import type { BookMetadata } from "../../formats/types.ts";
import { MIME_TYPES } from "../../types.ts";
import { encodeUrlPath, formatFileSize, normalizeFilenameTitle } from "../../utils/processor.ts";

// eslint-disable-next-line no-control-regex
const XML_1_0_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu;

/** The OPDS entry of one book. */
export function bookEntryXml(relativePath: string, name: string, meta: BookMetadata, hasCover: boolean, size: number): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const rawFilename = basename(relativePath).replace(/\.[^.]+$/, "");
  const title = sanitizeXmlText(meta.title || normalizeFilenameTitle(rawFilename));
  const encodedPath = encodeUrlPath(relativePath);
  const mimeType = MIME_TYPES.get(ext) ?? "application/octet-stream";

  const entry = new Entry(`urn:opds:book:${sanitizeXmlText(relativePath)}`, title);

  if (meta.author) entry.setAuthor(sanitizeXmlText(meta.author));

  if (meta.description) entry.setSummary(sanitizeXmlText(meta.description));
  entry.setDcMetadataField("format", ext.toUpperCase());
  entry.setContent({ type: "text", value: formatFileSize(size) });

  if (meta.publisher) entry.setDcMetadataField("publisher", sanitizeXmlText(meta.publisher));

  if (meta.issued) entry.setDcMetadataField("issued", sanitizeXmlText(meta.issued));

  if (meta.language) entry.setDcMetadataField("language", sanitizeXmlText(meta.language));

  if (meta.subjects) entry.setDcMetadataField("subjects", meta.subjects.map(sanitizeXmlText));

  if (meta.pageCount) entry.setDcMetadataField("extent", `${meta.pageCount} pages`);

  if (meta.series) entry.setDcMetadataField("isPartOf", sanitizeXmlText(meta.series));

  if (meta.rights) entry.setRights(sanitizeXmlText(meta.rights));

  if (hasCover) {
    entry.addImage(`/_catalog/${encodedPath}/cover.jpg`);
    entry.addThumbnail(`/_catalog/${encodedPath}/thumb.jpg`);
  }

  const encodedFilename = encodeURIComponent(name);
  entry.addAcquisition(`/_catalog/${encodedPath}/${encodedFilename}`, mimeType, "open-access");

  return entry.toXml({ prettyPrint: true });
}

/** Keep retained metadata byte-for-byte while migrating links to the public catalogue route. */
export function rewriteBookEntryLinks(entryXml: string, relativePath: string, name: string): string {
  const encodedPath = encodeUrlPath(relativePath);

  const links = new Map([
    ["http://opds-spec.org/image", `/_catalog/${encodedPath}/cover.jpg`],
    ["http://opds-spec.org/image/thumbnail", `/_catalog/${encodedPath}/thumb.jpg`],
    ["http://opds-spec.org/acquisition/open-access", `/_catalog/${encodedPath}/${encodeURIComponent(name)}`],
  ]);

  return entryXml.replace(/<link\b[^>]*>/g, (link) => {
    const rel = link.match(/\brel\s*=\s*(["'])(.*?)\1/u)?.[2];
    const href = rel === undefined ? undefined : links.get(rel);

    if (href === undefined) return link;

    const hrefAttribute = link.match(/\bhref\s*=\s*(["'])(.*?)\1/u);

    if (hrefAttribute === null) return link;

    const attribute = hrefAttribute[0];
    const value = hrefAttribute[2];

    if (value === undefined) return link;

    const start = hrefAttribute.index ?? 0;
    const replacement = attribute.replace(value, () => href);

    return link.slice(0, start) + replacement + link.slice(start + attribute.length);
  });
}

function sanitizeXmlText(value: string): string {
  return value.replace(XML_1_0_ILLEGAL, "");
}
