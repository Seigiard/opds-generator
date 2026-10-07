import { basename } from "node:path";
import { Entry } from "opds-ts/v1.2";
import type { BookMetadata } from "../../formats/types.ts";
import { MIME_TYPES } from "../../types.ts";
import { encodeUrlPath, formatFileSize, normalizeFilenameTitle } from "../../utils/processor.ts";

/** The OPDS entry of one book. */
export function bookEntryXml(relativePath: string, name: string, meta: BookMetadata, hasCover: boolean, size: number): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const rawFilename = basename(relativePath).replace(/\.[^.]+$/, "");
  const title = meta.title || normalizeFilenameTitle(rawFilename);
  const encodedPath = encodeUrlPath(relativePath);
  const mimeType = MIME_TYPES.get(ext) ?? "application/octet-stream";

  const entry = new Entry(`urn:opds:book:${relativePath}`, title);

  if (meta.author) entry.setAuthor(meta.author);

  if (meta.description) entry.setSummary(meta.description);
  entry.setDcMetadataField("format", ext.toUpperCase());
  entry.setContent({ type: "text", value: formatFileSize(size) });

  if (meta.publisher) entry.setDcMetadataField("publisher", meta.publisher);

  if (meta.issued) entry.setDcMetadataField("issued", meta.issued);

  if (meta.language) entry.setDcMetadataField("language", meta.language);

  if (meta.subjects) entry.setDcMetadataField("subjects", meta.subjects);

  if (meta.pageCount) entry.setDcMetadataField("extent", `${meta.pageCount} pages`);

  if (meta.series) entry.setDcMetadataField("isPartOf", meta.series);

  if (meta.rights) entry.setRights(meta.rights);

  if (hasCover) {
    entry.addImage(`/${encodedPath}/cover.jpg`);
    entry.addThumbnail(`/${encodedPath}/thumb.jpg`);
  }

  const encodedFilename = encodeURIComponent(name);
  entry.addAcquisition(`/${encodedPath}/${encodedFilename}`, mimeType, "open-access");

  return entry.toXml({ prettyPrint: true });
}
