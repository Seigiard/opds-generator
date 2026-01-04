import { mkdir, symlink, unlink, stat, rename } from "node:fs/promises";
import { join, basename, relative } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { MIME_TYPES, BOOK_EXTENSIONS } from "../types.ts";
import { getHandlerFactory } from "../formats/index.ts";
import type { BookMetadata } from "../formats/types.ts";
import { saveBufferAsImage, COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "../utils/image.ts";
import { encodeUrlPath, formatFileSize, normalizeFilenameTitle } from "../utils/processor.ts";
import { logger } from "../utils/errors.ts";
import { config } from "../config.ts";

const [parent, name, _events] = Bun.argv.slice(2);

if (!parent || !name) {
	logger.error("BookSync", "Usage: bun book-sync.ts <parent> <name> <events>");
	process.exit(1);
}

const ext = name.split(".").pop()?.toLowerCase() ?? "";
if (!BOOK_EXTENSIONS.includes(ext)) {
	logger.debug("BookSync", `Skipping non-book file: ${name}`);
	process.exit(0);
}

const filePath = join(parent, name);
const relativePath = relative(config.filesPath, filePath);
const bookDataDir = join(config.dataPath, relativePath);

async function atomicWrite(path: string, content: string): Promise<void> {
	const tmpPath = `${path}.tmp`;
	await Bun.write(tmpPath, content);
	await rename(tmpPath, path);
}

async function processBook(): Promise<void> {
	logger.info("BookSync", `Processing: ${relativePath}`);

	const fileStat = await stat(filePath);

	await mkdir(bookDataDir, { recursive: true });

	const createHandler = getHandlerFactory(ext);
	const rawFilename = basename(relativePath).replace(/\.[^.]+$/, "");
	let title = normalizeFilenameTitle(rawFilename);
	let author: string | undefined;
	let description: string | undefined;
	let hasCover = false;

	let meta: BookMetadata = { title: "" };

	if (createHandler) {
		try {
			const handler = await createHandler(filePath);
			if (handler) {
				meta = handler.getMetadata();
				if (meta.title) title = meta.title;
				author = meta.author;
				description = meta.description;

				const coverBuffer = await handler.getCover();
				if (coverBuffer) {
					const coverPath = join(bookDataDir, "cover.jpg");
					const thumbPath = join(bookDataDir, "thumb.jpg");

					const coverOk = await saveBufferAsImage(coverBuffer, coverPath, COVER_MAX_SIZE);
					if (coverOk) {
						await saveBufferAsImage(coverBuffer, thumbPath, THUMBNAIL_MAX_SIZE);
						hasCover = true;
					}
				}
			}
		} catch (error) {
			logger.warn("BookSync", `Failed to extract metadata: ${relativePath}`, {
				error: String(error),
			});
		}
	}

	const encodedPath = encodeUrlPath(relativePath);
	const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

	const entry = new Entry(`urn:opds:book:${relativePath}`, title);
	if (author) entry.setAuthor(author);
	if (description) entry.setSummary(description);
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

	entry.addAcquisition(`/${encodedPath}/file`, mimeType, "open-access");

	const entryXml = entry.toXml({ prettyPrint: true });
	await atomicWrite(join(bookDataDir, "entry.xml"), entryXml);

	const symlinkPath = join(bookDataDir, "file");
	try {
		await unlink(symlinkPath);
	} catch {
		// Symlink doesn't exist yet
	}
	await symlink(filePath, symlinkPath);

	logger.info("BookSync", `Done: ${relativePath}`, { hasCover });
}

try {
	await processBook();
} catch (error) {
	logger.error("BookSync", `Failed: ${relativePath}`, error);
	process.exit(1);
}
