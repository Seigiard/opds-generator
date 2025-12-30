import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { stripXmlDeclaration, naturalSort } from "./utils/opds.ts";
import { logger } from "./utils/errors.ts";

/**
 * Generates a complete feed.xml file for a folder by combining _feed.xml with all child entries.
 * Returns true if successful, false if folder has no _feed.xml.
 */
export async function generateFeedFile(folderPath: string, dataPath: string): Promise<boolean> {
  const folderDataDir = join(dataPath, folderPath);
  const feedHeaderPath = join(folderDataDir, "_feed.xml");
  const feedOutputPath = join(folderDataDir, "feed.xml");

  const feedHeaderFile = Bun.file(feedHeaderPath);
  if (!(await feedHeaderFile.exists())) {
    return false;
  }

  let feedXml = await feedHeaderFile.text();
  const entries: string[] = [];
  let hasBooks = false;

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
          entries.push(stripXmlDeclaration(entryXml));
        } else if (await bookEntryFile.exists()) {
          const entryXml = await bookEntryFile.text();
          entries.push(stripXmlDeclaration(entryXml));
          hasBooks = true;
        }
      }
    }
  } catch {
    // Empty folder or error reading
  }

  if (hasBooks) {
    feedXml = feedXml.replace("kind=navigation", "kind=acquisition");
  }

  const completeFeed = feedXml.replace("</feed>", entries.join("\n") + "\n</feed>");
  await Bun.write(feedOutputPath, completeFeed);

  logger.debug("FeedGen", `Generated ${folderPath || "/"}/feed.xml with ${entries.length} entries`);
  return true;
}

/**
 * Collects all folder paths that have _feed.xml, sorted by depth (deepest first).
 */
async function collectFeedFolders(dataPath: string): Promise<string[]> {
  const folders: string[] = [];

  async function scan(dirPath: string, relativePath: string): Promise<void> {
    const feedFile = Bun.file(join(dirPath, "_feed.xml"));
    if (await feedFile.exists()) {
      folders.push(relativePath);
    }

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith("_")) continue;

        const entryPath = join(dirPath, entry.name);
        const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        await scan(entryPath, entryRelPath);
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
