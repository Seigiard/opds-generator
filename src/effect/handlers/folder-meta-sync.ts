import { ok, err, type Result } from "neverthrow";
import { join, relative } from "node:path";
import { Feed, Entry } from "opds-ts/v1.2";
import { stripXmlDeclaration, naturalSort, extractTitle, extractAuthor } from "../../utils/opds.ts";
import { encodeUrlPath, formatFolderDescription, normalizeFilenameTitle } from "../../utils/processor.ts";
import type { HandlerDeps, FileSystemService } from "../../context.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, ENTRY_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";

interface EntryWithTitle {
  xml: string;
  title: string;
  author?: string;
  dirName: string;
}

async function readFolderEntries(
  normalizedDir: string,
  fs: FileSystemService,
): Promise<{ folderEntries: EntryWithTitle[]; bookEntries: EntryWithTitle[] }> {
  const folderEntries: EntryWithTitle[] = [];
  const bookEntries: EntryWithTitle[] = [];

  const items = await fs.readdir(normalizedDir);

  for (const item of items) {
    if (item.startsWith("_")) continue;
    if (item === FEED_FILE || item.endsWith(".tmp")) continue;

    const itemPath = join(normalizedDir, item);
    const itemStat = await fs.stat(itemPath);

    if (itemStat.isDirectory()) {
      const folderEntryPath = join(itemPath, FOLDER_ENTRY_FILE);
      const bookEntryPath = join(itemPath, ENTRY_FILE);

      if (await fs.exists(folderEntryPath)) {
        const entryXml = await Bun.file(folderEntryPath).text();
        const xml = stripXmlDeclaration(entryXml);
        const title = extractTitle(xml) || item;
        folderEntries.push({ xml, title, dirName: item });
      } else if (await fs.exists(bookEntryPath)) {
        const entryXml = await Bun.file(bookEntryPath).text();
        const xml = stripXmlDeclaration(entryXml);
        const title = extractTitle(xml) || item;
        const author = extractAuthor(xml);
        bookEntries.push({ xml, title, author, dirName: item });
      }
    }
  }

  return { folderEntries, bookEntries };
}

const sortByTitle = (a: EntryWithTitle, b: EntryWithTitle): number => {
  const cmp = naturalSort(a.title, b.title);
  return cmp !== 0 ? cmp : naturalSort(a.dirName, b.dirName);
};

const sortByAuthorTitle = (a: EntryWithTitle, b: EntryWithTitle): number => {
  if (!a.author && b.author) return -1;
  if (a.author && !b.author) return 1;
  if (a.author && b.author) {
    const authorCmp = naturalSort(a.author, b.author);
    if (authorCmp !== 0) return authorCmp;
  }
  const titleCmp = naturalSort(a.title, b.title);
  return titleCmp !== 0 ? titleCmp : naturalSort(a.dirName, b.dirName);
};

export const folderMetaSync = async (event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> => {
  if (event._tag !== "FolderMetaSyncRequested") return ok([]);

  const folderDataDir = event.path;
  const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
  const relativePath = relative(deps.config.dataPath, normalizedDir);

  if (relativePath !== "") {
    const sourceFolder = join(deps.config.filesPath, relativePath);
    try {
      const s = await deps.fs.stat(sourceFolder);
      if (!s.isDirectory()) {
        deps.logger.debug("FolderMetaSync", "Skipping (source folder deleted)", { path: relativePath });
        return ok([]);
      }
    } catch {
      deps.logger.debug("FolderMetaSync", "Skipping (source folder deleted)", { path: relativePath });
      return ok([]);
    }
  }

  return generateFeed(deps, normalizedDir, relativePath);
};

async function generateFeed(deps: HandlerDeps, normalizedDir: string, relativePath: string): Promise<Result<readonly EventType[], Error>> {
  deps.logger.info("FolderMetaSync", "Processing", { path: relativePath || "(root)" });

  let folderEntries: EntryWithTitle[];
  let bookEntries: EntryWithTitle[];

  try {
    const result = await readFolderEntries(normalizedDir, deps.fs);
    folderEntries = result.folderEntries;
    bookEntries = result.bookEntries;
  } catch (error) {
    deps.logger.warn("FolderMetaSync", "Error reading folder", { path: relativePath, error: String(error) });
    folderEntries = [];
    bookEntries = [];
  }

  folderEntries.sort(sortByTitle);
  bookEntries.sort(sortByAuthorTitle);

  const entries = [...folderEntries.map((e) => e.xml), ...bookEntries.map((e) => e.xml)];
  const hasBooks = bookEntries.length > 0;
  const feedKind = hasBooks ? "acquisition" : "navigation";

  const feedOutputPath = join(normalizedDir, FEED_FILE);
  const rawFolderName = relativePath.split("/").pop() || "Catalog";
  const folderName = rawFolderName === "Catalog" ? rawFolderName : normalizeFilenameTitle(rawFolderName);
  const feedId = relativePath === "" ? "urn:opds:catalog:root" : `urn:opds:catalog:${relativePath}`;
  const selfHref = relativePath === "" ? `/${FEED_FILE}` : `/${encodeUrlPath(relativePath)}/${FEED_FILE}`;

  const feed = new Feed(feedId, folderName).addSelfLink(selfHref, feedKind).addNavigationLink("start", `/${FEED_FILE}`).setKind(feedKind);

  const feedXml = feed.toXml({ prettyPrint: true });
  const stylesheet = '<?xml-stylesheet href="/static/layout.xsl" type="text/xsl"?>';
  const completeFeed = feedXml
    .replace('<?xml version="1.0" encoding="utf-8"?>', `<?xml version="1.0" encoding="utf-8"?>\n${stylesheet}`)
    .replace("</feed>", entries.join("\n") + "\n</feed>");

  try {
    await deps.fs.atomicWrite(feedOutputPath, completeFeed);

    deps.logger.info("FolderMetaSync", "Generated feed.xml", {
      path: relativePath || "/",
      subfolders: folderEntries.length,
      books: bookEntries.length,
    });

    if (relativePath !== "") {
      const entryOutputPath = join(normalizedDir, FOLDER_ENTRY_FILE);
      const entry = new Entry(`urn:opds:catalog:${relativePath}`, folderName).addSubsection(selfHref, "navigation");

      const description = formatFolderDescription(folderEntries.length, bookEntries.length);
      if (description) entry.setSummary(description);

      const entryXml = entry.toXml({ prettyPrint: true });
      await deps.fs.atomicWrite(entryOutputPath, entryXml);
      deps.logger.debug("FolderMetaSync", "Updated _entry.xml count", { path: relativePath });
    }

    return ok([]);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
