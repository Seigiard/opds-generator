import { Effect } from "effect";
import { join, relative } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { Feed, Entry } from "opds-ts/v1.2";
import { stripXmlDeclaration, naturalSort, extractTitle, extractAuthor } from "../../utils/opds.ts";
import { encodeUrlPath, formatFolderDescription, normalizeFilenameTitle } from "../../utils/processor.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, ENTRY_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";
import { log } from "../../logging/index.ts";

interface EntryWithTitle {
  xml: string;
  title: string;
  author?: string;
  dirName: string;
}

async function readFolderEntries(normalizedDir: string): Promise<{
  folderEntries: EntryWithTitle[];
  bookEntries: EntryWithTitle[];
}> {
  const folderEntries: EntryWithTitle[] = [];
  const bookEntries: EntryWithTitle[] = [];

  const items = await readdir(normalizedDir);

  for (const item of items) {
    if (item.startsWith("_")) continue;
    if (item === FEED_FILE || item.endsWith(".tmp")) continue;

    const itemPath = join(normalizedDir, item);
    const itemStat = await stat(itemPath);

    if (itemStat.isDirectory()) {
      const folderEntryPath = join(itemPath, FOLDER_ENTRY_FILE);
      const bookEntryPath = join(itemPath, ENTRY_FILE);

      const folderEntryFile = Bun.file(folderEntryPath);
      const bookEntryFile = Bun.file(bookEntryPath);

      if (await folderEntryFile.exists()) {
        const entryXml = await folderEntryFile.text();
        const xml = stripXmlDeclaration(entryXml);
        const title = extractTitle(xml) || item;
        folderEntries.push({ xml, title, dirName: item });
      } else if (await bookEntryFile.exists()) {
        const entryXml = await bookEntryFile.text();
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

export const folderMetaSync = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> => {
  if (event._tag !== "FolderMetaSyncRequested") return Effect.succeed([]);

  return Effect.flatMap(ConfigService, (config) =>
    Effect.flatMap(FileSystemService, (fs) => {
      const folderDataDir = event.path;
      const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
      const relativePath = relative(config.dataPath, normalizedDir);

      if (relativePath !== "") {
        const sourceFolder = join(config.filesPath, relativePath);
        return fs.stat(sourceFolder).pipe(
          Effect.map((s) => s.isDirectory()),
          Effect.catchAll(() => Effect.succeed(false)),
          Effect.flatMap((exists) => {
            if (!exists) {
              log.debug("FolderMetaSync", "Skipping (source folder deleted)", { path: relativePath });
              return Effect.succeed([] as readonly EventType[]);
            }
            return generateFeed(fs, normalizedDir, relativePath);
          }),
        );
      }

      return generateFeed(fs, normalizedDir, relativePath);
    }),
  );
};

function generateFeed(
  fs: {
    atomicWrite: (path: string, content: string) => Effect.Effect<void, Error>;
  },
  normalizedDir: string,
  relativePath: string,
): Effect.Effect<readonly EventType[], Error> {
  log.info("FolderMetaSync", "Processing", { path: relativePath || "(root)" });

  return Effect.tryPromise({
    try: () => readFolderEntries(normalizedDir),
    catch: (e) => e as Error,
  }).pipe(
    Effect.catchAll((error) => {
      log.warn("FolderMetaSync", "Error reading folder", { path: relativePath, error: String(error) });
      return Effect.succeed({ folderEntries: [] as EntryWithTitle[], bookEntries: [] as EntryWithTitle[] });
    }),
    Effect.flatMap(({ folderEntries, bookEntries }) => {
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

      const feed = new Feed(feedId, folderName)
        .addSelfLink(selfHref, feedKind)
        .addNavigationLink("start", `/${FEED_FILE}`)
        .setKind(feedKind);

      const feedXml = feed.toXml({ prettyPrint: true });
      const stylesheet = '<?xml-stylesheet href="/static/layout.xsl" type="text/xsl"?>';
      const completeFeed = feedXml
        .replace('<?xml version="1.0" encoding="utf-8"?>', `<?xml version="1.0" encoding="utf-8"?>\n${stylesheet}`)
        .replace("</feed>", entries.join("\n") + "\n</feed>");

      const writeFeed = fs.atomicWrite(feedOutputPath, completeFeed);

      log.info("FolderMetaSync", "Generated feed.xml", {
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

        return writeFeed.pipe(
          Effect.flatMap(() => fs.atomicWrite(entryOutputPath, entryXml)),
          Effect.map(() => {
            log.debug("FolderMetaSync", "Updated _entry.xml count", { path: relativePath });
            return [] as const;
          }),
        );
      }

      return Effect.map(writeFeed, () => [] as const);
    }),
  );
}
