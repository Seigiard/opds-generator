import { Effect } from "effect";
import { ExtractionFailed, type BookMetadata, type ExtractedBook, type FormatExtractorRegistration } from "./types.ts";
import { listArchiveEntries, readArchiveEntry, readArchiveEntryText } from "../utils/archive.ts";
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

interface OpfReading {
  readonly meta: BookMetadata;
  readonly metadataCover: string | undefined;
}

const extractEpub = Effect.fn("extractEpub")(function* (filePath: string) {
  const container = yield* readArchiveEntryText(filePath, "META-INF/container.xml");

  if (!container) return yield* ExtractionFailed.of(filePath, "no META-INF/container.xml");

  const opfPath = yield* parseXml(filePath, container, findOpfPath);

  if (!opfPath) return yield* ExtractionFailed.of(filePath, "container names no OPF");

  const opf = yield* readArchiveEntryText(filePath, opfPath);

  if (!opf) return yield* ExtractionFailed.of(filePath, `no OPF at ${opfPath}`);

  const reading = yield* parseXml(filePath, opf, (opfData) => readOpf(opfData, opfPath.replace(/[^/]+$/, "")));

  if (!reading) return yield* ExtractionFailed.of(filePath, "OPF has no package metadata");

  const coverPath = reading.metadataCover ?? (yield* listArchiveEntries(filePath).pipe(Effect.map(findCoverByName)));

  const book: ExtractedBook = { meta: reading.meta, cover: coverPath ? yield* readArchiveEntry(filePath, coverPath) : null };

  return book;
});

export const epubExtractorRegistration: FormatExtractorRegistration = {
  extensions: ["epub"],
  extract: extractEpub,
};

/** Unparseable required XML is logged and fails extraction, so the catalogue falls back to the filename. */
function parseXml<A>(filePath: string, xml: string, read: (data: XmlFields) => A): Effect.Effect<A, ExtractionFailed> {
  return Effect.try({
    try: () => read(v.parse(xmlFieldsSchema, xmlParser.parse(xml))),
    catch: (cause) => cause,
  }).pipe(
    Effect.tapError((cause) => Effect.sync(() => logHandlerError("EPUB", filePath, cause))),
    Effect.mapError((cause) => ExtractionFailed.of(filePath, cause)),
  );
}

function readOpf(opfData: XmlFields, opfDir: string): OpfReading | null {
  const opfPackage = xmlFields(opfData.package);

  if (!opfPackage || opfPackage.metadata === undefined || opfPackage.metadata === null) return null;

  return { meta: extractMetadata(opfPackage), metadataCover: findCoverPath(opfPackage, opfDir) };
}

/** Filename fallbacks when the OPF names no cover (EPUB 2 meta or EPUB 3 cover-image). */
function findCoverByName(entries: string[]): string | undefined {
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
