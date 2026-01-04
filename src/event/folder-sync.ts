import { mkdir, readdir, rename } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { encodeUrlPath, formatFolderDescription } from "../utils/processor.ts";
import { logger } from "../utils/errors.ts";
import { config } from "../config.ts";
import { BOOK_EXTENSIONS } from "../types.ts";

const [parent, name, _events] = Bun.argv.slice(2);

if (!parent || !name) {
	logger.error("FolderSync", "Usage: bun folder-sync.ts <parent> <name> <events>");
	process.exit(1);
}

const folderPath = join(parent, name);
const relativePath = relative(config.filesPath, folderPath);
const folderDataDir = join(config.dataPath, relativePath);

async function atomicWrite(path: string, content: string): Promise<void> {
	const tmpPath = `${path}.tmp`;
	await Bun.write(tmpPath, content);
	await rename(tmpPath, path);
}

async function countContents(): Promise<{ subfolders: number; books: number }> {
	let subfolders = 0;
	let books = 0;

	try {
		const entries = await readdir(folderPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				subfolders++;
			} else if (entry.isFile()) {
				const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
				if (BOOK_EXTENSIONS.includes(ext)) {
					books++;
				}
			}
		}
	} catch {
		// Folder might not exist yet or be inaccessible
	}

	return { subfolders, books };
}

async function processFolder(): Promise<void> {
	logger.info("FolderSync", `Processing: ${relativePath || "(root)"}`);

	await mkdir(folderDataDir, { recursive: true });

	// Only create _entry.xml for non-root folders
	if (relativePath !== "") {
		const folderName = basename(relativePath);
		const { subfolders, books } = await countContents();

		const entry = new Entry(`urn:opds:catalog:${relativePath}`, folderName).addSubsection(
			`/${encodeUrlPath(relativePath)}/feed.xml`,
			"navigation",
		);

		const description = formatFolderDescription(subfolders, books);
		if (description) {
			entry.setSummary(description);
		}

		const entryXml = entry.toXml({ prettyPrint: true });
		await atomicWrite(join(folderDataDir, "_entry.xml"), entryXml);

		logger.info("FolderSync", `Done: ${relativePath}`, { subfolders, books });
	} else {
		logger.info("FolderSync", "Root folder - no _entry.xml needed");
	}
}

try {
	await processFolder();
} catch (error) {
	logger.error("FolderSync", `Failed: ${relativePath}`, error);
	process.exit(1);
}
