import { Feed, Entry } from "opds-ts/v1.2";
import type { BookMeta } from "./types.ts";
import { formatFileSize } from "./metadata.ts";

function encodeUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function feedId(path: string): string {
  return `urn:opds:catalog:${path || "root"}`;
}

interface NavigationEntry {
  title: string;
  href: string;
  count?: number;
}

export function buildNavigationFeed(title: string, path: string, entries: NavigationEntry[], baseUrl: string): string {
  const selfHref = path ? `${baseUrl}/opds/${encodeUrlPath(path)}` : `${baseUrl}/opds`;

  const feed = new Feed(feedId(path), title)
    .setKind("navigation")
    .addSelfLink(selfHref, "navigation")
    .addNavigationLink("start", `${baseUrl}/opds`);

  for (const entry of entries) {
    const e = new Entry(feedId(entry.href), entry.title).addSubsection(
      `${baseUrl}/opds/${encodeUrlPath(entry.href)}`,
      "navigation",
    );

    if (entry.count !== undefined) {
      e.setContent({ type: "text", value: `${entry.count} books` });
    }

    feed.addEntry(e);
  }

  return feed.toXml({ prettyPrint: true });
}

export function buildAcquisitionFeed(title: string, path: string, books: BookMeta[], baseUrl: string): string {
  const selfHref = `${baseUrl}/opds/${encodeUrlPath(path)}`;

  const feed = new Feed(feedId(path), title)
    .setKind("acquisition")
    .addSelfLink(selfHref, "acquisition")
    .addNavigationLink("start", `${baseUrl}/opds`);

  for (const book of books) {
    const e = new Entry(`urn:opds:book:${book.filePath}`, book.title);

    if (book.author) e.setAuthor(book.author);
    if (book.description) e.setSummary(book.description);

    e.setDcMetadataField("format", book.format);
    e.setContent({ type: "text", value: formatFileSize(book.fileSize) });

    e.addImage(`${baseUrl}/cover/${encodeUrlPath(book.filePath)}`);
    e.addThumbnail(`${baseUrl}/thumbnail/${encodeUrlPath(book.filePath)}`);

    e.addAcquisition(`${baseUrl}/download/${encodeUrlPath(book.filePath)}`, book.mimeType, "open-access");

    feed.addEntry(e);
  }

  return feed.toXml({ prettyPrint: true });
}

export function buildMixedFeed(
  title: string,
  path: string,
  subfolders: NavigationEntry[],
  books: BookMeta[],
  baseUrl: string,
): string {
  const selfHref = path ? `${baseUrl}/opds/${encodeUrlPath(path)}` : `${baseUrl}/opds`;

  const kind = subfolders.length > 0 && books.length === 0 ? "navigation" : "acquisition";

  const feed = new Feed(feedId(path), title)
    .setKind(kind)
    .addSelfLink(selfHref, kind)
    .addNavigationLink("start", `${baseUrl}/opds`);

  for (const entry of subfolders) {
    const e = new Entry(feedId(entry.href), entry.title).addSubsection(
      `${baseUrl}/opds/${encodeUrlPath(entry.href)}`,
      "navigation",
    );

    if (entry.count !== undefined) {
      e.setContent({ type: "text", value: `${entry.count} books` });
    }

    feed.addEntry(e);
  }

  for (const book of books) {
    const e = new Entry(`urn:opds:book:${book.filePath}`, book.title);

    if (book.author) e.setAuthor(book.author);
    if (book.description) e.setSummary(book.description);

    e.setDcMetadataField("format", book.format);
    e.setContent({ type: "text", value: formatFileSize(book.fileSize) });

    e.addImage(`${baseUrl}/cover/${encodeUrlPath(book.filePath)}`);
    e.addThumbnail(`${baseUrl}/thumbnail/${encodeUrlPath(book.filePath)}`);

    e.addAcquisition(`${baseUrl}/download/${encodeUrlPath(book.filePath)}`, book.mimeType, "open-access");

    feed.addEntry(e);
  }

  return feed.toXml({ prettyPrint: true });
}

export function pathToFilename(path: string): string {
  if (!path) return "root.xml";
  return path.replace(/\//g, "--") + ".xml";
}

export function filenameToPath(filename: string): string {
  if (filename === "root.xml") return "";
  return filename.replace(/\.xml$/, "").replace(/--/g, "/");
}
