import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function buildFeed(folderPath: string, dataPath: string): Promise<string | null> {
  const folderDataDir = join(dataPath, folderPath);
  const feedHeaderPath = join(folderDataDir, "_feed.xml");

  const feedHeaderFile = Bun.file(feedHeaderPath);
  if (!(await feedHeaderFile.exists())) {
    return null;
  }

  const feedHeader = await feedHeaderFile.text();
  const entries: string[] = [];

  try {
    const items = await readdir(folderDataDir);

    for (const item of items) {
      if (item.startsWith("_")) continue;

      const itemPath = join(folderDataDir, item);
      const itemStat = await stat(itemPath);

      if (itemStat.isDirectory()) {
        const folderEntryPath = join(itemPath, "_entry.xml");
        const bookEntryPath = join(itemPath, "entry.xml");

        const folderEntryFile = Bun.file(folderEntryPath);
        const bookEntryFile = Bun.file(bookEntryPath);

        if (await folderEntryFile.exists()) {
          entries.push(await folderEntryFile.text());
        } else if (await bookEntryFile.exists()) {
          entries.push(await bookEntryFile.text());
        }
      }
    }
  } catch {
    // Empty folder
  }

  return feedHeader.replace("</feed>", entries.join("\n") + "\n</feed>");
}

export async function getFeedUpdated(folderPath: string, dataPath: string): Promise<Date | null> {
  const feedHeaderPath = join(dataPath, folderPath, "_feed.xml");
  const file = Bun.file(feedHeaderPath);

  if (await file.exists()) {
    return new Date(file.lastModified);
  }

  return null;
}
