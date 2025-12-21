import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

function stripXmlDeclaration(xml: string): string {
  return xml.replace(/<\?xml[^?]*\?>\s*/g, "").trim();
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function naturalSort(a: string, b: string): number {
  return collator.compare(a, b);
}

export async function buildFeed(folderPath: string, dataPath: string): Promise<string | null> {
  const folderDataDir = join(dataPath, folderPath);
  const feedHeaderPath = join(folderDataDir, "_feed.xml");

  const feedHeaderFile = Bun.file(feedHeaderPath);
  if (!(await feedHeaderFile.exists())) {
    return null;
  }

  let feedXml = await feedHeaderFile.text();
  const entries: string[] = [];
  let hasBooks = false;

  try {
    const items = await readdir(folderDataDir);
    items.sort(naturalSort);

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
    // Empty folder
  }

  if (hasBooks) {
    feedXml = feedXml.replace("kind=navigation", "kind=acquisition");
  }

  return feedXml.replace("</feed>", entries.join("\n") + "\n</feed>");
}
