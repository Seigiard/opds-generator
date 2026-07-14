import { createXmlParser, getString } from "../formats/utils.ts";
import { entryFromFragment, type FeedModel } from "./feed-model.ts";

const feedParser = createXmlParser(["link"]);
const ENTRY_RE = /<entry>[\s\S]*?<\/entry>/g;

interface RawLink {
  "@_rel"?: string;
  "@_href"?: string;
  "@_type"?: string;
}

function toLinks(value: unknown): RawLink[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]) as RawLink[];
}

export function parseFeed(xml: string): FeedModel {
  const fragments = xml.match(ENTRY_RE) ?? [];
  const shell = xml.replace(ENTRY_RE, "");
  const parsed = feedParser.parse(shell) as { feed?: Record<string, unknown> };
  const feed = parsed.feed ?? {};

  const links = toLinks(feed.link);
  const self = links.find((l) => l["@_rel"] === "self");
  const start = links.find((l) => l["@_rel"] === "start");
  const kind: FeedModel["kind"] = self?.["@_type"]?.includes("kind=acquisition") ? "acquisition" : "navigation";

  return {
    id: getString(feed.id) ?? "",
    title: getString(feed.title) ?? "",
    updated: getString(feed.updated) ?? "",
    kind,
    selfHref: self?.["@_href"] ?? "/feed.xml",
    startHref: start?.["@_href"] ?? "/feed.xml",
    entries: fragments.map(entryFromFragment),
  };
}
