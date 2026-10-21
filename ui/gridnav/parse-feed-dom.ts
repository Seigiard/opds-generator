import type { FeedEntry, FeedModel } from "../../src/render/feed-model.ts";

const ENTRY_RE = /<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/g;

const IMAGE_REL = "http://opds-spec.org/image";

const THUMBNAIL_REL = "http://opds-spec.org/image/thumbnail";

const SUBSECTION_REL = "subsection";

interface FeedLink {
  rel?: string;
  href?: string;
  type?: string;
}

function hasLocalName(element: Element, name: string): boolean {
  return element.localName === name || element.tagName.split(":").at(-1) === name;
}

function childrenNamed(element: Element, name: string): Element[] {
  const result: Element[] = [];

  for (const child of Array.from(element.children)) {
    if (hasLocalName(child, name)) result.push(child);
  }

  return result;
}

function firstChildNamed(element: Element, name: string): Element | undefined {
  return childrenNamed(element, name)[0];
}

function attribute(element: Element, name: string): string | undefined {
  const value = element.getAttribute(name);

  return value === null ? undefined : value;
}

function stringValue(element: Element): string | undefined {
  const children = Array.from(element.children);

  if (children.length > 0) {
    let hasTextNode = false;
    let text = "";

    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType !== 3 && node.nodeType !== 4) continue;
      hasTextNode = true;
      text += node.nodeValue ?? "";
    }

    return hasTextNode ? text.trim() : undefined;
  }

  return element.textContent?.trim() ?? "";
}

function childString(element: Element, name: string): string | undefined {
  const child = firstChildNamed(element, name);

  return child ? stringValue(child) : undefined;
}

function links(element: Element): FeedLink[] {
  const result: FeedLink[] = [];

  for (const link of childrenNamed(element, "link")) {
    result.push({
      rel: attribute(link, "rel"),
      href: attribute(link, "href"),
      type: attribute(link, "type"),
    });
  }

  return result;
}

function hrefFor(linksToSearch: FeedLink[], rel: string): string | undefined {
  for (const link of linksToSearch) {
    if (link.rel === rel) return link.href;
  }

  return undefined;
}

function malformedEntry(xml: string): FeedEntry {
  return { xml, kind: "book", id: "", title: "" };
}

function parseXml(xml: string): XMLDocument {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function hasParserError(document: XMLDocument): boolean {
  for (const element of Array.from(document.querySelectorAll("*"))) {
    if (hasLocalName(element, "parsererror")) return true;
  }

  return false;
}

function parseEntryDocument(shell: string, fragment: string): Element | undefined {
  const closingFeed = shell.search(/<\/(?:[A-Za-z_][\w.-]*:)?feed\s*>/);

  if (closingFeed === -1) return undefined;

  const document = parseXml(`${shell.slice(0, closingFeed)}${fragment}${shell.slice(closingFeed)}`);

  if (hasParserError(document)) return undefined;

  const root = document.documentElement;

  return root && hasLocalName(root, "feed") ? firstChildNamed(root, "entry") : undefined;
}

function parseEntry(xml: string, root: Element): FeedEntry {
  try {
    if (!root || !hasLocalName(root, "entry")) return malformedEntry(xml);

    const entryLinks = links(root);
    const subsectionHref = hrefFor(entryLinks, SUBSECTION_REL);
    const acquisitions: { href: string; type: string }[] = [];

    for (const link of entryLinks) {
      if (!link.rel?.includes("acquisition")) continue;
      const href = link.href ?? "";

      if (href) acquisitions.push({ href, type: link.type ?? "" });
    }

    const subjects: string[] = [];

    for (const subject of childrenNamed(root, "subject")) {
      const value = stringValue(subject);

      if (value) subjects.push(value);
    }

    const authorElement = firstChildNamed(root, "author");
    const authorName = authorElement ? firstChildNamed(authorElement, "name") : undefined;

    return {
      xml,
      kind: subsectionHref ? "folder" : "book",
      id: childString(root, "id") ?? "",
      title: childString(root, "title") ?? "",
      author: authorName ? stringValue(authorName) : undefined,
      summary: childString(root, "summary"),
      href: subsectionHref,
      cover: hrefFor(entryLinks, IMAGE_REL),
      thumbnail: hrefFor(entryLinks, THUMBNAIL_REL),
      subjects: subjects.length > 0 ? subjects : undefined,
      format: childString(root, "format"),
      content: childString(root, "content"),
      issued: childString(root, "issued"),
      language: childString(root, "language"),
      isPartOf: childString(root, "isPartOf"),
      acquisitions: acquisitions.length > 0 ? acquisitions : undefined,
    };
  } catch {
    return malformedEntry(xml);
  }
}

export function parseFeedDom(xml: string): FeedModel {
  const fragments = xml.match(ENTRY_RE) ?? [];
  const shell = xml.replace(ENTRY_RE, "");
  const root = parseXml(shell).documentElement;
  const feed = root && hasLocalName(root, "feed") ? root : undefined;
  const feedLinks = feed ? links(feed) : [];
  const self = feedLinks.find((link) => link.rel === "self");
  const start = feedLinks.find((link) => link.rel === "start");
  const entryElements = fragments.map((fragment) => parseEntryDocument(shell, fragment));

  return {
    id: feed ? (childString(feed, "id") ?? "") : "",
    title: feed ? (childString(feed, "title") ?? "") : "",
    updated: feed ? (childString(feed, "updated") ?? "") : "",
    kind: self?.type?.includes("kind=acquisition") ? "acquisition" : "navigation",
    selfHref: self?.href ?? "/feed.xml",
    startHref: start?.href ?? "/feed.xml",
    entries: fragments.map((fragment, index) => {
      const entry = entryElements[index];

      return entry ? parseEntry(fragment, entry) : malformedEntry(fragment);
    }),
  };
}
