import { XMLParser } from "fast-xml-parser";
import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { readEntry, readEntryText, listEntries } from "../utils/archive.ts";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ["subject", "creator", "item", "meta"].includes(name),
});

interface OPFMeta {
  "@_name"?: string;
  "@_content"?: string;
}

interface OPFItem {
  "@_id": string;
  "@_href": string;
  "@_properties"?: string;
}

interface OPFPackage {
  package: {
    metadata: {
      title?: unknown;
      creator?: unknown;
      description?: unknown;
      publisher?: unknown;
      date?: unknown;
      language?: unknown;
      subject?: unknown;
      rights?: unknown;
      meta?: OPFMeta[];
    };
    manifest: {
      item: OPFItem[];
    };
  };
}

interface RootFile {
  "@_full-path"?: string;
  "@_media-type"?: string;
}

interface ContainerXML {
  container?: {
    rootfiles?: {
      rootfile?: RootFile | RootFile[];
    };
  };
}

function findOpfPath(containerData: ContainerXML): string | undefined {
  const rootfiles = containerData.container?.rootfiles?.rootfile;
  if (!rootfiles) return undefined;

  const files = Array.isArray(rootfiles) ? rootfiles : [rootfiles];

  // Prefer OPF by media-type
  const opf = files.find((f) => f["@_media-type"] === "application/oebps-package+xml");
  if (opf?.["@_full-path"]) return opf["@_full-path"];

  // Fallback to first with full-path
  return files[0]?.["@_full-path"];
}

function decodeEntities(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function getString(val: unknown): string | undefined {
  if (typeof val === "string") return decodeEntities(val.trim());
  if (typeof val === "object" && val && "#text" in val) {
    return decodeEntities(String((val as { "#text": unknown })["#text"]).trim());
  }
  return undefined;
}

function getFirstString(val: unknown): string | undefined {
  if (Array.isArray(val)) return getString(val[0]);
  return getString(val);
}

function getStringArray(val: unknown): string[] | undefined {
  if (!val) return undefined;
  const arr = Array.isArray(val) ? val : [val];
  const result = arr.map(getString).filter((s): s is string => !!s);
  return result.length > 0 ? result : undefined;
}

function cleanDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  return (
    desc
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim() || undefined
  );
}

function parseDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const match = date.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!match) return undefined;
  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}

function extractMetadata(opfData: OPFPackage): BookMetadata {
  const meta = opfData.package.metadata;
  return {
    title: getString(meta.title) ?? "",
    author: getFirstString(meta.creator),
    description: cleanDescription(getString(meta.description)),
    publisher: getString(meta.publisher),
    issued: parseDate(getString(meta.date)),
    language: getString(meta.language),
    subjects: getStringArray(meta.subject),
    rights: getString(meta.rights),
  };
}

function findCoverPath(opfData: OPFPackage, opfDir: string): string | undefined {
  const meta = opfData.package.metadata;
  const manifest = opfData.package.manifest?.item ?? [];

  // 1. EPUB 2.0: <meta name="cover" content="cover-id"/>
  const metas = meta.meta ?? [];
  const coverMeta = metas.find((m) => m["@_name"] === "cover");
  if (coverMeta) {
    const coverId = coverMeta["@_content"];
    const item = manifest.find((i) => i["@_id"] === coverId);
    if (item) return opfDir + item["@_href"];
  }

  // 2. EPUB 3.0: <item properties="cover-image"/>
  const coverItem = manifest.find((i) => i["@_properties"]?.includes("cover-image"));
  if (coverItem) return opfDir + coverItem["@_href"];

  return undefined;
}

async function findCoverWithFallback(
  opfData: OPFPackage,
  opfDir: string,
  filePath: string
): Promise<string | undefined> {
  // 1. Try metadata (EPUB 2.0 + 3.0)
  const metaCover = findCoverPath(opfData, opfDir);
  if (metaCover) return metaCover;

  // 2. Search by filename
  const entries = await listEntries(filePath);
  const images = entries.filter((e) => /\.(jpe?g|png|gif|webp)$/i.test(e));

  // 2a. File named "cover.*"
  const namedCover = images.find((e) => /cover\.(jpe?g|png|gif|webp)$/i.test(e.toLowerCase()));
  if (namedCover) return namedCover;

  // 2b. File containing "cover" in name
  const containsCover = images.find((e) => e.toLowerCase().includes("cover"));
  if (containsCover) return containsCover;

  // 3. First image as last fallback
  return images.sort()[0];
}

async function createEpubHandler(filePath: string): Promise<FormatHandler | null> {
  try {
    const container = await readEntryText(filePath, "META-INF/container.xml");
    if (!container) return null;

    const containerData = xmlParser.parse(container) as ContainerXML;
    const opfPath = findOpfPath(containerData);
    if (!opfPath) return null;

    const opf = await readEntryText(filePath, opfPath);
    if (!opf) return null;

    const opfData = xmlParser.parse(opf) as OPFPackage;
    const opfDir = opfPath.replace(/[^/]+$/, "");

    const metadata = extractMetadata(opfData);
    const coverPath = await findCoverWithFallback(opfData, opfDir, filePath);

    return {
      getMetadata() {
        return metadata;
      },
      async getCover() {
        if (!coverPath) return null;
        return readEntry(filePath, coverPath);
      },
    };
  } catch {
    return null;
  }
}

export const epubHandlerRegistration: FormatHandlerRegistration = {
  extensions: ["epub"],
  create: createEpubHandler,
};
