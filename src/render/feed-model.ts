import { createXmlParser, getString, getStringArray } from "../formats/utils.ts";
import * as v from "valibot";
import { xmlFields, xmlFieldsSchema } from "../formats/xml-value.ts";
import type { XmlValue, XmlFields } from "../formats/xml-value.ts";

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

const linkSchema = v.object({
  "@_rel": v.optional(v.string()),
  "@_href": v.optional(v.string()),
  "@_type": v.optional(v.string()),
});

type RawLink = v.InferOutput<typeof linkSchema>;

const entryParser = createXmlParser(["link", "subject"]);

export function toLinks(value: XmlValue | undefined): RawLink[] {
  if (!value) return [];

  const links: RawLink[] = [];

  for (const candidate of Array.isArray(value) ? value : [value]) {
    const link = v.safeParse(linkSchema, candidate);

    if (link.success) links.push(link.output);
  }

  return links;
}

export function entryFromFragment(xml: string): FeedEntry {
  let e: XmlFields;

  try {
    const parsed = v.parse(xmlFieldsSchema, entryParser.parse(xml));
    e = xmlFields(parsed.entry) ?? {};
  } catch {
    // A malformed cached entry.xml degrades the HTML card only — renderXml splices
    // the verbatim fragment regardless, and feed.xml generation must never block (R2).
    return { xml, kind: "book", id: "", title: "" };
  }

  const links = toLinks(e.link);

  const findHref = (rel: string): string | undefined =>
    links.find((l) => l["@_rel"] === rel)?.["@_href"];

  const acquisitions = links
    .filter((l) => l["@_rel"]?.includes("acquisition"))
    .map((l) => ({ href: l["@_href"] ?? "", type: l["@_type"] ?? "" }))
    .filter((a) => a.href);

  const subsectionHref = findHref(SUBSECTION_REL);
  const kind: FeedEntry["kind"] = subsectionHref ? "folder" : "book";

  const author = getString(xmlFields(e.author)?.name);

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
