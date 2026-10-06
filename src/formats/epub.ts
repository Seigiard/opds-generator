import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { readEntry, readEntryText, listEntries } from "../utils/archive.ts";
import { createXmlParser, getString, getFirstString, getStringArray, cleanDescription, parseDate } from "./utils.ts";
import { logHandlerError } from "../logging/index.ts";
import * as v from "valibot";
import { xmlFieldsSchema, xmlFields } from "./xml-value.ts";
import type { XmlFields } from "./xml-value.ts";

const xmlParser = createXmlParser(["subject", "creator", "item", "meta"]);

const rootFileSchema = v.object({
  "@_full-path": v.optional(v.string()),
  "@_media-type": v.optional(v.string()),
});

function findOpfPath(containerData: XmlFields): string | undefined {
  const rootfiles = xmlFields(xmlFields(containerData.container)?.rootfiles)?.rootfile;

  if (!rootfiles) return undefined;

  const files = (Array.isArray(rootfiles) ? rootfiles : [rootfiles]).flatMap((candidate) => {
    const fields = xmlFields(candidate);

    if (!fields) return [];
    const rootfile = v.safeParse(rootFileSchema, fields);

    return rootfile.success ? [rootfile.output] : [];
  });

  // Prefer OPF by media-type
  const opf = files.find((f) => f["@_media-type"] === "application/oebps-package+xml");

  if (opf?.["@_full-path"]) return opf["@_full-path"];

  // Fallback to the first candidate's full-path.
  return files[0]?.["@_full-path"];
}

function extractMetadata(opfPackage: XmlFields): BookMetadata {
  const meta = xmlFields(opfPackage.metadata) ?? {};

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

function findCoverPath(opfPackage: XmlFields, opfDir: string): string | undefined {
  const meta = xmlFields(opfPackage.metadata) ?? {};
  const rawItems = xmlFields(opfPackage.manifest)?.item;

  const manifest = (Array.isArray(rawItems) ? rawItems : []).flatMap((candidate) => {
    const item = v.safeParse(
      v.object({
        "@_id": v.optional(v.string()),
        "@_href": v.string(),
        "@_properties": v.optional(v.string()),
      }),
      candidate,
    );

    return item.success ? [item.output] : [];
  });

  // 1. EPUB 2.0: <meta name="cover" content="cover-id"/>
  const metas = (Array.isArray(meta.meta) ? meta.meta : []).flatMap((candidate) => {
    const item = v.safeParse(
      v.object({
        "@_name": v.optional(v.string()),
        "@_content": v.optional(v.string()),
      }),
      candidate,
    );

    return item.success ? [item.output] : [];
  });

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
  opfPackage: XmlFields,
  opfDir: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // 1. Try metadata (EPUB 2.0 + 3.0)
  const metaCover = findCoverPath(opfPackage, opfDir);

  if (metaCover) return metaCover;

  // 2. Search by filename
  const entries = await listEntries(filePath, signal);
  const images = entries.filter((e) => /\.(jpe?g|png|gif|webp)$/i.test(e));

  // 2a. File named "cover.*"
  const namedCover = images.find((e) => /cover\.(jpe?g|png|gif|webp)$/i.test(e.toLowerCase()));

  if (namedCover) return namedCover;

  // 2b. File containing "cover" in name
  const containsCover = images.find((e) => e.toLowerCase().includes("cover"));

  if (containsCover) return containsCover;

  // 3. First image as last fallback
  const sorted = images.sort();

  return sorted[0];
}

async function createEpubHandler(filePath: string, signal?: AbortSignal): Promise<FormatHandler | null> {
  try {
    const container = await readEntryText(filePath, "META-INF/container.xml", signal);

    if (!container) return null;

    const containerData = v.parse(xmlFieldsSchema, xmlParser.parse(container));
    const opfPath = findOpfPath(containerData);

    if (!opfPath) return null;

    const opf = await readEntryText(filePath, opfPath, signal);

    if (!opf) return null;

    const opfData = v.parse(xmlFieldsSchema, xmlParser.parse(opf));
    const opfPackage = xmlFields(opfData.package);

    if (!opfPackage || opfPackage.metadata === undefined || opfPackage.metadata === null) return null;
    const opfDir = opfPath.replace(/[^/]+$/, "");

    const metadata = extractMetadata(opfPackage);
    const coverPath = await findCoverWithFallback(opfPackage, opfDir, filePath, signal);

    return {
      getMetadata() {
        return metadata;
      },
      async getCover() {
        if (!coverPath) return null;

        return readEntry(filePath, coverPath, signal);
      },
    };
  } catch (error) {
    signal?.throwIfAborted();
    logHandlerError("EPUB", filePath, error);

    return null;
  }
}

export const epubHandlerRegistration: FormatHandlerRegistration = {
  extensions: ["epub"],
  create: createEpubHandler,
};
