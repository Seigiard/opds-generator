import { createXmlParser, getString, getStringArray } from "../formats/utils.ts";

const IMAGE_REL = "http://opds-spec.org/image";
const THUMBNAIL_REL = "http://opds-spec.org/image/thumbnail";
const SUBSECTION_REL = "subsection";

export interface AcquisitionLink {
  href: string;
  type: string;
}

export interface FeedEntry {
  /** Verbatim entry fragment (declaration-stripped) — spliced by renderXml unchanged. */
  xml: string;
  kind: "folder" | "book";
  id: string;
  title: string;
  author?: string;
  summary?: string;
  /** Folder navigation href (subsection link). */
  href?: string;
  cover?: string;
  thumbnail?: string;
  subjects?: string[];
  format?: string;
  content?: string;
  issued?: string;
  language?: string;
  isPartOf?: string;
  acquisitions?: AcquisitionLink[];
}

export interface FeedModel {
  id: string;
  title: string;
  updated: string;
  kind: "navigation" | "acquisition";
  selfHref: string;
  startHref: string;
  entries: FeedEntry[];
}

interface RawLink {
  "@_rel"?: string;
  "@_href"?: string;
  "@_type"?: string;
}

const entryParser = createXmlParser(["link", "subject"]);

export function toLinks(value: unknown): RawLink[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]) as RawLink[];
}

export function entryFromFragment(xml: string): FeedEntry {
  let e: Record<string, unknown>;
  try {
    const parsed = entryParser.parse(xml) as { entry?: Record<string, unknown> };
    e = parsed.entry ?? {};
  } catch {
    // A malformed cached entry.xml degrades the HTML card only — renderXml splices
    // the verbatim fragment regardless, and feed.xml generation must never block (R2).
    return { xml, kind: "book", id: "", title: "" };
  }

  const links = toLinks(e.link);
  const findHref = (rel: string): string | undefined => links.find((l) => l["@_rel"] === rel)?.["@_href"];
  const acquisitions = links
    .filter((l) => l["@_rel"]?.includes("acquisition"))
    .map((l) => ({ href: l["@_href"] ?? "", type: l["@_type"] ?? "" }))
    .filter((a) => a.href);

  const subsectionHref = findHref(SUBSECTION_REL);
  const kind: FeedEntry["kind"] = subsectionHref ? "folder" : "book";

  const author = e.author && typeof e.author === "object" ? getString((e.author as { name?: unknown }).name) : undefined;

  return {
    xml,
    kind,
    id: getString(e.id) ?? "",
    title: getString(e.title) ?? "",
    author,
    summary: getString(e.summary),
    href: subsectionHref,
    cover: findHref(IMAGE_REL),
    thumbnail: findHref(THUMBNAIL_REL),
    subjects: getStringArray(e.subject),
    format: getString(e.format),
    content: getString(e.content),
    issued: getString(e.issued),
    language: getString(e.language),
    isPartOf: getString(e.isPartOf),
    acquisitions: acquisitions.length > 0 ? acquisitions : undefined,
  };
}

export function buildFeedModel(params: {
  id: string;
  title: string;
  updated: string;
  kind: FeedModel["kind"];
  selfHref: string;
  startHref: string;
  fragments: string[];
}): FeedModel {
  return {
    id: params.id,
    title: params.title,
    updated: params.updated,
    kind: params.kind,
    selfHref: params.selfHref,
    startHref: params.startHref,
    entries: params.fragments.map(entryFromFragment),
  };
}
