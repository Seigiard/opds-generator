import { Effect } from "effect";
import { join, relative } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { Feed } from "opds-ts/v1.2";
import { stripXmlDeclaration, naturalSort } from "../../utils/opds.ts";
import { encodeUrlPath } from "../../utils/processor.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";

export const folderMetaSync = (
	event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
	Effect.gen(function* () {
		if (event._tag !== "FolderMetaSyncRequested") return [];
		const folderDataDir = event.path;
		const config = yield* ConfigService;
		const logger = yield* LoggerService;
		const fs = yield* FileSystemService;

		const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
		const relativePath = relative(config.dataPath, normalizedDir);

		yield* logger.info("FolderMetaSync", `Processing: ${relativePath || "(root)"}`);

		const feedOutputPath = join(normalizedDir, "feed.xml");
		const folderName = relativePath.split("/").pop() || "Catalog";
		const feedId = relativePath === "" ? "urn:opds:catalog:root" : `urn:opds:catalog:${relativePath}`;
		const selfHref = relativePath === "" ? "/feed.xml" : `/${encodeUrlPath(relativePath)}/feed.xml`;

		const feed = new Feed(feedId, folderName)
			.addSelfLink(selfHref, "navigation")
			.addNavigationLink("start", "/feed.xml");

		const folderEntries: string[] = [];
		const bookEntries: string[] = [];

		// Read directory contents
		const readResult = yield* Effect.tryPromise({
			try: async () => {
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

				return { folderEntries, bookEntries };
			},
			catch: (e) => e as Error,
		}).pipe(
			Effect.catchAll((error) => {
				logger.warn("FolderMetaSync", `Error reading folder: ${relativePath}`, {
					error: String(error),
				});
				return Effect.succeed({ folderEntries: [] as string[], bookEntries: [] as string[] });
			}),
		);

		const entries = [...readResult.folderEntries, ...readResult.bookEntries];
		const hasBooks = readResult.bookEntries.length > 0;

		feed.setKind(hasBooks ? "acquisition" : "navigation");

		const feedXml = feed.toXml({ prettyPrint: true });
		const stylesheet = '<?xml-stylesheet href="/static/layout.xsl" type="text/xsl"?>';
		const completeFeed = feedXml
			.replace(
				'<?xml version="1.0" encoding="utf-8"?>',
				`<?xml version="1.0" encoding="utf-8"?>\n${stylesheet}`,
			)
			.replace("</feed>", entries.join("\n") + "\n</feed>");

		yield* fs.atomicWrite(feedOutputPath, completeFeed);

		yield* logger.info("FolderMetaSync", `Generated ${relativePath || "/"}/feed.xml`, {
			folders: readResult.folderEntries.length,
			books: readResult.bookEntries.length,
		});

		return [];
	});
