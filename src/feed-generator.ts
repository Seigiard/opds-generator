import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Feed } from "opds-ts/v1.2";
import { stripXmlDeclaration, naturalSort } from "./utils/opds.ts";
import { encodeUrlPath } from "./utils/processor.ts";
import { logger } from "./utils/errors.ts";

/**
 * Generates a complete feed.xml file for a folder.
 * Header is generated dynamically from folder path, entries are read from child folders.
 */
export async function generateFeedFile(folderPath: string, dataPath: string): Promise<boolean> {
  const folderDataDir = join(dataPath, folderPath);
  const feedOutputPath = join(folderDataDir, "feed.xml");

  // Generate feed header dynamically
  const folderName = folderPath.split("/").pop() || "Catalog";
  const feedId = folderPath === "" ? "urn:opds:catalog:root" : `urn:opds:catalog:${folderPath}`;
  const selfHref = folderPath === "" ? "/feed.xml" : `/${encodeUrlPath(folderPath)}/feed.xml`;

  const feed = new Feed(feedId, folderName).addSelfLink(selfHref, "navigation").addNavigationLink("start", "/feed.xml");

  // Collect entries from subfolders (folders first, then books)
  const folderEntries: string[] = [];
  const bookEntries: string[] = [];

  try {
    const items = await readdir(folderDataDir);
    items.sort(naturalSort);

    for (const item of items) {
      if (item.startsWith("_")) continue;
      if (item === "feed.xml") continue;

      const itemPath = join(folderDataDir, item);
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
  } catch {
    // Empty folder or error reading
  }

  const entries = [...folderEntries, ...bookEntries];
  const hasBooks = bookEntries.length > 0;

  // Set feed kind based on content
  feed.setKind(hasBooks ? "acquisition" : "navigation");

  // Build complete feed XML with XSLT stylesheet reference
  const feedXml = feed.toXml({ prettyPrint: true });
  const stylesheet = '<?xml-stylesheet href="/static/layout.xsl" type="text/xsl"?>';
  const completeFeed = feedXml
    .replace('<?xml version="1.0" encoding="utf-8"?>', `<?xml version="1.0" encoding="utf-8"?>\n${stylesheet}`)
    .replace("</feed>", entries.join("\n") + "\n</feed>");
  await Bun.write(feedOutputPath, completeFeed);

  logger.debug("FeedGen", `Generated ${folderPath || "/"}/feed.xml with ${entries.length} entries`);
  return true;
}

/**
 * Collects all folder paths that have _entry.xml or are root, sorted by depth (deepest first).
 */
async function collectFeedFolders(dataPath: string): Promise<string[]> {
  const folders: string[] = [""];

  async function scan(dirPath: string, relativePath: string): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith("_")) continue;

        const entryPath = join(dirPath, entry.name);
        const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        // Check if this is a folder with _entry.xml (not a book folder)
        const hasEntryXml = await Bun.file(join(entryPath, "_entry.xml")).exists();
        if (hasEntryXml) {
          folders.push(entryRelPath);
          await scan(entryPath, entryRelPath);
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }

  await scan(dataPath, "");

  // Sort by depth (deepest first) for bottom-up generation
  folders.sort((a, b) => {
    const depthA = a === "" ? 0 : a.split("/").length;
    const depthB = b === "" ? 0 : b.split("/").length;
    return depthB - depthA;
  });

  return folders;
}

/**
 * Generates all feed.xml files in the data directory.
 * Processes from deepest folders to root to ensure children are ready before parents.
 */
export async function generateAllFeeds(dataPath: string): Promise<void> {
  const startTime = Date.now();
  const folders = await collectFeedFolders(dataPath);

  logger.info("FeedGen", `Generating ${folders.length} feeds...`);

  for (const folder of folders) {
    await generateFeedFile(folder, dataPath);
  }

  const duration = Date.now() - startTime;
  logger.info("FeedGen", `Generated ${folders.length} feeds in ${duration}ms`);
}
