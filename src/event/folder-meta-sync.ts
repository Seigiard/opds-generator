import { readdir, stat, rename } from "node:fs/promises";
import { join, relative } from "node:path";
import { Feed } from "opds-ts/v1.2";
import { stripXmlDeclaration, naturalSort } from "../utils/opds.ts";
import { encodeUrlPath } from "../utils/processor.ts";
import { logger } from "../utils/errors.ts";
import { config } from "../config.ts";

const [folderDataDir, _name, _events] = Bun.argv.slice(2);

if (!folderDataDir) {
	logger.error("FolderMetaSync", "Usage: bun folder-meta-sync.ts <folder-data-dir> [name] [events]");
	process.exit(1);
}

const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
const relativePath = relative(config.dataPath, normalizedDir);

async function atomicWrite(path: string, content: string): Promise<void> {
	const tmpPath = `${path}.tmp`;
	await Bun.write(tmpPath, content);
	await rename(tmpPath, path);
}

async function generateFeedXml(): Promise<void> {
	const feedOutputPath = join(normalizedDir, "feed.xml");

	const folderName = relativePath.split("/").pop() || "Catalog";
	const feedId = relativePath === "" ? "urn:opds:catalog:root" : `urn:opds:catalog:${relativePath}`;
	const selfHref = relativePath === "" ? "/feed.xml" : `/${encodeUrlPath(relativePath)}/feed.xml`;

	const feed = new Feed(feedId, folderName)
		.addSelfLink(selfHref, "navigation")
		.addNavigationLink("start", "/feed.xml");

	const folderEntries: string[] = [];
	const bookEntries: string[] = [];

	try {
		const items = await readdir(normalizedDir);
		items.sort(naturalSort);

		for (const item of items) {
			if (item.startsWith("_")) continue;
			if (item === "feed.xml" || item.endsWith(".tmp")) continue;

			const itemPath = join(normalizedDir, item);
			const itemStat = await stat(itemPath);

			if (itemStat.isDirectory()) {
				const folderEntryPath = join(itemPath, "_entry.xml");
				const bookEntryPath = join(itemPath, "entry.xml");

				const folderEntryFile = Bun.file(folderEntryPath);
				const bookEntryFile = Bun.file(bookEntryPath);

				if (await folderEntryFile.exists()) {
					const entryXml = await folderEntryFile.text();
					folderEntries.push(stripXmlDeclaration(entryXml));
				} else if (await bookEntryFile.exists()) {
					const entryXml = await bookEntryFile.text();
					bookEntries.push(stripXmlDeclaration(entryXml));
				}
			}
		}
	} catch (error) {
		logger.warn("FolderMetaSync", `Error reading folder: ${relativePath}`, {
			error: String(error),
		});
	}

	const entries = [...folderEntries, ...bookEntries];
	const hasBooks = bookEntries.length > 0;

	feed.setKind(hasBooks ? "acquisition" : "navigation");

	const feedXml = feed.toXml({ prettyPrint: true });
	const stylesheet = '<?xml-stylesheet href="/static/layout.xsl" type="text/xsl"?>';
	const completeFeed = feedXml
		.replace(
			'<?xml version="1.0" encoding="utf-8"?>',
			`<?xml version="1.0" encoding="utf-8"?>\n${stylesheet}`,
		)
		.replace("</feed>", entries.join("\n") + "\n</feed>");

	await atomicWrite(feedOutputPath, completeFeed);

	logger.info("FolderMetaSync", `Generated ${relativePath || "/"}/feed.xml`, {
		folders: folderEntries.length,
		books: bookEntries.length,
	});
}

async function sync(): Promise<void> {
	logger.info("FolderMetaSync", `Processing: ${relativePath || "(root)"}`);

	// Only regenerate feed.xml
	// _entry.xml is managed by folder-sync.ts to avoid infinite loops
	await generateFeedXml();
}

try {
	await sync();
} catch (error) {
	logger.error("FolderMetaSync", `Failed: ${relativePath}`, error);
	process.exit(1);
}
