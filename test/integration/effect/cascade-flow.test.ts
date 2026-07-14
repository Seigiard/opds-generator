import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { bookSync } from "../../../src/effect/handlers/book-sync.ts";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import { folderMetaSync } from "../../../src/effect/handlers/folder-meta-sync.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/effect/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile, symlink, unlink } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `opds-cascade-test-${Date.now()}`);
const FILES_DIR = join(TEST_DIR, "files");
const DATA_DIR = join(TEST_DIR, "data");
const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const mockLogger = {
  calls: [] as Array<{ level: string; tag: string; msg: string }>,
  reset() {
    this.calls = [];
  },
};

const asyncDeps: HandlerDeps = {
  config: { filesPath: FILES_DIR, dataPath: DATA_DIR, port: 3000, reconcileInterval: 1800 },
  logger: {
    info: (tag, msg) => mockLogger.calls.push({ level: "info", tag, msg }),
    warn: (tag, msg) => mockLogger.calls.push({ level: "warn", tag, msg }),
    error: (tag, msg) => mockLogger.calls.push({ level: "error", tag, msg }),
    debug: (tag, msg) => mockLogger.calls.push({ level: "debug", tag, msg }),
  },
  fs: {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    rm: (path, options) => rm(path, options),
    readdir: async (path) => {
      const fs = await import("node:fs/promises");
      return fs.readdir(path);
    },
    stat: async (path) => {
      const s = await stat(path);
      return { isDirectory: () => s.isDirectory(), size: s.size };
    },
    exists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    writeFile: async (path, content) => {
      await Bun.write(path, content);
    },
    atomicWrite: async (path, content) => {
      await Bun.write(path, content);
    },
    symlink: async (target, path) => {
      await symlink(target, path);
    },
    unlink: (path) => unlink(path),
  },
};

describe("Cascade Flow Integration", () => {
  beforeEach(async () => {
    mockLogger.reset();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(FILES_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("full cascade: FolderCreated → BookCreated → FolderMetaSync", async () => {
    // Step 1: Create folder structure in files
    const fictionPath = join(FILES_DIR, "Fiction");
    await mkdir(fictionPath, { recursive: true });

    // Step 2: Process folder creation event
    const folderEvent: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" };
    await folderSync(folderEvent, asyncDeps);

    // Verify folder data directory and _entry.xml created
    const fictionDataPath = join(DATA_DIR, "Fiction");
    const entryXmlPath = join(fictionDataPath, "_entry.xml");
    const entryExists = await stat(entryXmlPath)
      .then(() => true)
      .catch(() => false);
    expect(entryExists).toBe(true);

    // Step 3: Copy real EPUB to files
    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(fictionPath, "Test Book - Test Author.epub");
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    // Step 4: Process book creation event
    const bookEvent: EventType = { _tag: "BookCreated", parent: fictionPath, name: "Test Book - Test Author.epub" };
    await bookSync(bookEvent, asyncDeps);

    // Verify book data directory created with entry.xml, cover, symlink
    const bookDataPath = join(DATA_DIR, "Fiction", "Test Book - Test Author.epub");
    const bookEntryPath = join(bookDataPath, "entry.xml");
    const coverPath = join(bookDataPath, "cover.jpg");
    const symlinkPath = join(bookDataPath, "Test Book - Test Author.epub");

    expect(
      await stat(bookEntryPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await stat(coverPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await stat(symlinkPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    // Step 5: Process folder meta sync for Fiction folder
    const folderMetaEvent: EventType = { _tag: "FolderMetaSyncRequested", path: fictionDataPath };
    await folderMetaSync(folderMetaEvent, asyncDeps);

    // Verify feed.xml generated with book entry
    const feedPath = join(fictionDataPath, "feed.xml");
    const feedContent = await readFile(feedPath, "utf-8");

    expect(feedContent).toContain("<feed");
    expect(feedContent).toContain("Test Book");
    expect(feedContent).toContain("Test Author");
    expect(feedContent).toContain("kind=acquisition");

    // Step 6: Process root folder meta sync
    const rootMetaEvent: EventType = { _tag: "FolderMetaSyncRequested", path: DATA_DIR };
    await folderMetaSync(rootMetaEvent, asyncDeps);

    // Verify root feed.xml generated with Fiction folder entry
    const rootFeedPath = join(DATA_DIR, "feed.xml");
    const rootFeedContent = await readFile(rootFeedPath, "utf-8");

    expect(rootFeedContent).toContain("<feed");
    expect(rootFeedContent).toContain("Fiction");
    expect(rootFeedContent).toContain("kind=navigation");
  });

  test("characterization: feed.xml is deterministic and splices fragments verbatim modulo <updated>", async () => {
    // #given a data folder holding a book entry.xml and a subfolder _entry.xml
    const libFiles = join(FILES_DIR, "lib");
    await mkdir(libFiles, { recursive: true });
    const libData = join(DATA_DIR, "lib");
    const bookDir = join(libData, "book.epub");
    const subDir = join(libData, "Sub");
    await mkdir(bookDir, { recursive: true });
    await mkdir(subDir, { recursive: true });

    const bookEntry = `<?xml version="1.0"?>
<entry>
  <id>urn:opds:book:book.epub</id>
  <title>Test Book</title>
  <updated>2026-01-08T04:52:36.379Z</updated>
  <dc:format>EPUB</dc:format>
  <author>
    <name>Test Author</name>
  </author>
  <link rel="http://opds-spec.org/acquisition/open-access" href="/lib/book.epub/file" type="application/epub+zip"/>
</entry>`;
    const subEntry = `<?xml version="1.0"?>
<entry>
  <id>urn:opds:catalog:lib/Sub</id>
  <title>Sub</title>
  <updated>2026-01-08T04:52:36.379Z</updated>
  <summary type="text">📚 1</summary>
  <link rel="subsection" href="/lib/Sub/feed.xml" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
</entry>`;
    await Bun.write(join(bookDir, "entry.xml"), bookEntry);
    await Bun.write(join(subDir, "_entry.xml"), subEntry);

    // #when folderMetaSync runs twice
    const event: EventType = { _tag: "FolderMetaSyncRequested", path: libData };
    await folderMetaSync(event, asyncDeps);
    const first = await readFile(join(libData, "feed.xml"), "utf-8");
    const subEntryAfter = await readFile(join(subDir, "_entry.xml"), "utf-8");
    await folderMetaSync(event, asyncDeps);
    const second = await readFile(join(libData, "feed.xml"), "utf-8");

    // #then output is stable modulo volatile <updated> timestamps
    const normalize = (xml: string) => xml.replace(/<updated>[^<]*<\/updated>/g, "<updated>X</updated>");
    expect(normalize(first)).toBe(normalize(second));
    // and no XSLT stylesheet PI is emitted (post-flip); acquisition kind is present
    expect(first).not.toContain("xml-stylesheet");
    expect(first).toContain("kind=acquisition");
    // and fragments are spliced verbatim (book after folder)
    expect(first).toContain("urn:opds:book:book.epub");
    expect(first).toContain('<link rel="subsection" href="/lib/Sub/feed.xml"');
    expect(first.indexOf("urn:opds:catalog:lib/Sub")).toBeLessThan(first.indexOf("urn:opds:book:book.epub"));
    // and the subfolder's own _entry.xml is untouched by the parent sync
    expect(subEntryAfter).toBe(subEntry);
  });

  test("AE4: cascade writes feed.xml and a consistent index.html", async () => {
    // #given a data folder with a book entry
    await mkdir(join(FILES_DIR, "lib"), { recursive: true });
    const libData = join(DATA_DIR, "lib");
    const bookDir = join(libData, "book.epub");
    await mkdir(bookDir, { recursive: true });
    await Bun.write(
      join(bookDir, "entry.xml"),
      `<?xml version="1.0"?>
<entry>
  <id>urn:opds:book:book.epub</id>
  <title>Consistent Title</title>
  <updated>2026-01-08T04:52:36.379Z</updated>
  <dc:format>EPUB</dc:format>
  <link rel="http://opds-spec.org/acquisition/open-access" href="/lib/book.epub/file" type="application/epub+zip"/>
</entry>`,
    );

    // #when folderMetaSync runs
    await folderMetaSync({ _tag: "FolderMetaSyncRequested", path: libData }, asyncDeps);

    // #then both artifacts exist and reflect the same book
    const feed = await readFile(join(libData, "feed.xml"), "utf-8");
    const html = await readFile(join(libData, "index.html"), "utf-8");
    expect(feed).toContain("Consistent Title");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Consistent Title");
    expect(html).toContain('class="card card--book"');
  });

  test("R16: re-running the sync overwrites index.html", async () => {
    await mkdir(join(FILES_DIR, "lib"), { recursive: true });
    const libData = join(DATA_DIR, "lib");
    await mkdir(libData, { recursive: true });
    const event: EventType = { _tag: "FolderMetaSyncRequested", path: libData };

    await folderMetaSync(event, asyncDeps);
    const first = await stat(join(libData, "index.html"));
    await folderMetaSync(event, asyncDeps);
    const second = await stat(join(libData, "index.html"));

    // #then index.html is regenerated (still present after a second unconditional sync)
    expect(second.isFile()).toBe(true);
    expect(second.size).toBeGreaterThan(0);
    expect(first.isFile()).toBe(true);
  });

  test("index.html render failure is isolated: feed.xml still written, handler ok", async () => {
    // #given a deps whose index.html write always fails
    await mkdir(join(FILES_DIR, "lib"), { recursive: true });
    const libData = join(DATA_DIR, "lib");
    await mkdir(libData, { recursive: true });
    const errors: string[] = [];
    const failingDeps: HandlerDeps = {
      ...asyncDeps,
      logger: { ...asyncDeps.logger, error: (_tag, msg) => errors.push(msg) },
      fs: {
        ...asyncDeps.fs,
        atomicWrite: async (path, content) => {
          if (path.endsWith("index.html")) throw new Error("disk full");
          await Bun.write(path, content);
        },
      },
    };

    // #when folderMetaSync runs
    const result = await folderMetaSync({ _tag: "FolderMetaSyncRequested", path: libData }, failingDeps);

    // #then the feed is written, the failure is logged, and the handler still succeeds
    expect(result.isOk()).toBe(true);
    expect(await stat(join(libData, "feed.xml")).then(() => true)).toBe(true);
    expect(errors.some((m) => m.includes("index.html"))).toBe(true);
  });

  test("characterization: empty folder yields a valid navigation feed", async () => {
    // #given an empty data folder with a matching source folder
    await mkdir(join(FILES_DIR, "empty"), { recursive: true });
    const emptyData = join(DATA_DIR, "empty");
    await mkdir(emptyData, { recursive: true });

    // #when folderMetaSync runs
    await folderMetaSync({ _tag: "FolderMetaSyncRequested", path: emptyData }, asyncDeps);

    // #then a navigation feed with no entries and no stylesheet PI is written
    const feed = await readFile(join(emptyData, "feed.xml"), "utf-8");
    expect(feed).toContain("kind=navigation");
    expect(feed).not.toContain("xml-stylesheet");
    expect(feed).not.toContain("<entry>");
  });

  test("cascade produces correct OPDS structure", async () => {
    // Setup: folder with book
    const authorPath = join(FILES_DIR, "Author");
    await mkdir(authorPath, { recursive: true });

    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(authorPath, "Test Book - Test Author.epub");
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    // Process events
    const folderEvent: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: "Author" };
    await folderSync(folderEvent, asyncDeps);

    const bookEvent: EventType = { _tag: "BookCreated", parent: authorPath, name: "Test Book - Test Author.epub" };
    await bookSync(bookEvent, asyncDeps);

    const folderMetaEvent: EventType = { _tag: "FolderMetaSyncRequested", path: join(DATA_DIR, "Author") };
    await folderMetaSync(folderMetaEvent, asyncDeps);

    const rootMetaEvent: EventType = { _tag: "FolderMetaSyncRequested", path: DATA_DIR };
    await folderMetaSync(rootMetaEvent, asyncDeps);

    // Verify complete OPDS structure
    const rootFeed = await readFile(join(DATA_DIR, "feed.xml"), "utf-8");
    const authorFeed = await readFile(join(DATA_DIR, "Author", "feed.xml"), "utf-8");
    const bookEntry = await readFile(join(DATA_DIR, "Author", "Test Book - Test Author.epub", "entry.xml"), "utf-8");

    // Root feed has navigation link to Author
    expect(rootFeed).toContain("Author");
    expect(rootFeed).toContain("kind=navigation");

    // Author feed has acquisition link to book
    expect(authorFeed).toContain("Test Book");
    expect(authorFeed).toContain("kind=acquisition");

    // Book entry has metadata
    expect(bookEntry).toContain("Test Book");
    expect(bookEntry).toContain("Test Author");
    expect(bookEntry).toContain("urn:opds:book:");
  });
});
