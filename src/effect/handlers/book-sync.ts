import { ok, err, type Result } from "neverthrow";
import { join, basename, relative } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { MIME_TYPES } from "../../types.ts";
import { getHandlerFactory } from "../../formats/index.ts";
import type { BookMetadata } from "../../formats/types.ts";
import { saveCoverAndThumbnail, COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "../../utils/image.ts";
import { encodeUrlPath, formatFileSize, normalizeFilenameTitle } from "../../utils/processor.ts";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";
import { ENTRY_FILE, COVER_FILE, THUMB_FILE } from "../../constants.ts";

async function extractMetadataAndCover(
  filePath: string,
  ext: string,
  bookDataDir: string,
): Promise<{ meta: BookMetadata; hasCover: boolean }> {
  const createHandler = getHandlerFactory(ext);
  if (!createHandler) return { meta: { title: "" }, hasCover: false };

  try {
    const handler = await createHandler(filePath);
    if (!handler) return { meta: { title: "" }, hasCover: false };

    const meta = handler.getMetadata();
    let cover = await handler.getCover();
    let hasCover = false;

    if (cover) {
      try {
        hasCover = await saveCoverAndThumbnail(
          cover,
          join(bookDataDir, COVER_FILE),
          COVER_MAX_SIZE,
          join(bookDataDir, THUMB_FILE),
          THUMBNAIL_MAX_SIZE,
        );
      } catch {
        hasCover = false;
      }
      cover = null;
    }

    return { meta, hasCover };
  } catch {
    return { meta: { title: "" }, hasCover: false };
  }
}

export const bookSync = async (event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> => {
  if (event._tag !== "BookCreated") return ok([]);

  const { parent, name } = event;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const filePath = join(parent, name);
  const relativePath = relative(deps.config.filesPath, filePath);
  const bookDataDir = join(deps.config.dataPath, relativePath);

  deps.logger.info("BookSync", "Processing", { path: relativePath });

  try {
    const fileStat = await deps.fs.stat(filePath);
    await deps.fs.mkdir(bookDataDir, { recursive: true });

    let meta: BookMetadata;
    let hasCover: boolean;
    try {
      const result = await extractMetadataAndCover(filePath, ext, bookDataDir);
      meta = result.meta;
      hasCover = result.hasCover;
    } catch {
      meta = { title: "" };
      hasCover = false;
    }

    const rawFilename = basename(relativePath).replace(/\.[^.]+$/, "");
    const title = meta.title || normalizeFilenameTitle(rawFilename);
    const encodedPath = encodeUrlPath(relativePath);
    const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

    const entry = new Entry(`urn:opds:book:${relativePath}`, title);
    if (meta.author) entry.setAuthor(meta.author);
    if (meta.description) entry.setSummary(meta.description);
    entry.setDcMetadataField("format", ext.toUpperCase());
    entry.setContent({ type: "text", value: formatFileSize(fileStat.size) });

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

    const entryXml = entry.toXml({ prettyPrint: true });

    await deps.fs.atomicWrite(join(bookDataDir, ENTRY_FILE), entryXml);
    await deps.fs.symlink(filePath, join(bookDataDir, name));

    deps.logger.info("BookSync", "Done", { path: relativePath, has_cover: hasCover });
    return ok([]);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
};
