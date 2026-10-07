import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { bookSyncEffect } from "../../../../src/processing/handlers/book-sync-effect.ts";
import { runAsPromiseHandler, type TestHandlerDeps } from "../../../helpers/effect-test-handlers.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/processing/types.ts";
import {
  mockPdfInfo,
  mockPdfToPpmExit,
  mockPdfToPpmHangUntilKilled,
  mockPdfToPpmSpawnFailure,
  resetMocks,
} from "../../../helpers/mock-tools.ts";
import { assertCoverMatchesReference } from "../../../helpers/image-compare.ts";
import { SAMPLE_IMAGES, buildComic, sampleImage } from "../../../helpers/comic-archives.ts";
import sharp from "sharp";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, readdir, stat, readFile, readlink, lstat, symlink, unlink } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `opds-book-sync-test-${Date.now()}`);

const FILES_DIR = join(TEST_DIR, "files");

const DATA_DIR = join(TEST_DIR, "data");

const FIXTURES_DIR = join(import.meta.dir, "../../../../files/test");

const deps: HandlerDeps = {
  config: { filesPath: FILES_DIR, dataPath: DATA_DIR, port: 3000, reconcileInterval: 1800 },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fs: {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    rm: (path, options) => rm(path, options),
    readdir: (path) => readdir(path),
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
      try {
        await unlink(path);
      } catch {}

      await symlink(target, path);
    },
    unlink: (path) => unlink(path),
  },
};

const bookCreatedEvent = (relativePath: string): EventType => {
  const parts = relativePath.split("/");
  const name = parts.pop()!;
  const parent = join(FILES_DIR, parts.join("/"));

  return { _tag: "BookCreated", parent, name };
};

const bookSync = (event: EventType, handlerDeps: HandlerDeps) => runAsPromiseHandler(bookSyncEffect, event, handlerDeps);

describe("bookSync handler", () => {
  beforeEach(async () => {
    resetMocks();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(FILES_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });
  });

  afterAll(async () => {
    resetMocks();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("returns empty array for non-BookCreated events", async () => {
    const event: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" };
    const result = await bookSync(event, deps);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("cancellation preserves the previous entry and does not create a download link", async () => {
    // #given
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const bookDir = join(DATA_DIR, "test.epub");
    await Bun.write(join(FILES_DIR, "test.epub"), "invalid epub");
    await mkdir(bookDir);
    await Bun.write(join(bookDir, "entry.xml"), "previous entry");

    const cancellableDeps: TestHandlerDeps = {
      ...deps,
      signal: controller.signal,
      fs: {
        ...deps.fs,
        mkdir: async (path, options) => {
          await deps.fs.mkdir(path, options);
          controller.abort(reason);
        },
      },
    };

    // #when
    const result = await bookSync(bookCreatedEvent("test.epub"), cancellableDeps);
    // #then
    expect({
      error: result._unsafeUnwrapErr(),
      entry: await Bun.file(join(bookDir, "entry.xml")).text(),
      linkExists: await Bun.file(join(bookDir, "test.epub")).exists(),
    }).toEqual({ error: reason, entry: "previous entry", linkExists: false });
  });

  test("finishes download publication when cancellation arrives during entry write", async () => {
    // #given
    const controller = new AbortController();
    const bookPath = join(FILES_DIR, "test.txt");
    await Bun.write(bookPath, "source book");

    const cancellingDeps: TestHandlerDeps = {
      ...deps,
      signal: controller.signal,
      fs: {
        ...deps.fs,
        atomicWrite: async (path, content) => {
          await deps.fs.atomicWrite(path, content);
          controller.abort(new Error("shutdown"));
        },
      },
    };

    // #when
    const result = await bookSync(bookCreatedEvent("test.txt"), cancellingDeps);
    // #then
    expect(result.isOk()).toBe(true);
    expect(await readlink(join(DATA_DIR, "test.txt", "test.txt"))).toBe(bookPath);
  });

  test("creates data directory for book", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("test.epub"), deps);

    const dataDir = join(DATA_DIR, "test.epub");

    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(true);
  });

  test("creates entry.xml with book metadata", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("test.epub"), deps);

    const entryPath = join(DATA_DIR, "test.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");
    expect(entryContent).toContain("<entry");
    expect(entryContent).toContain("test");
    expect(entryContent).toContain("urn:opds:book:");
  });

  test("creates symlink to original file", async () => {
    const bookPath = join(FILES_DIR, "test.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("test.epub"), deps);

    const symlinkPath = join(DATA_DIR, "test.epub", "test.epub");
    const linkStat = await lstat(symlinkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  test("extracts metadata from real EPUB", async () => {
    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(FILES_DIR, "Test Book - Test Author.epub");
    await mkdir(FILES_DIR, { recursive: true });
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    await bookSync(bookCreatedEvent("Test Book - Test Author.epub"), deps);

    const entryPath = join(DATA_DIR, "Test Book - Test Author.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");
    expect(entryContent).toContain("Test Book");
    expect(entryContent).toContain("Test Author");
  });

  test("extracts cover from real EPUB", async () => {
    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(FILES_DIR, "Test Book - Test Author.epub");
    await mkdir(FILES_DIR, { recursive: true });
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    await bookSync(bookCreatedEvent("Test Book - Test Author.epub"), deps);

    const coverPath = join(DATA_DIR, "Test Book - Test Author.epub", "cover.jpg");
    const thumbPath = join(DATA_DIR, "Test Book - Test Author.epub", "thumb.jpg");

    const coverExists = await stat(coverPath)
      .then(() => true)
      .catch(() => false);

    const thumbExists = await stat(thumbPath)
      .then(() => true)
      .catch(() => false);

    expect(coverExists).toBe(true);
    expect(thumbExists).toBe(true);
  });

  test("publishes a PDF with metadata, cover, thumbnail, download link and a folder refresh", async () => {
    // #given a known source book
    const name = "Test Book - Test Author.pdf";
    const bookPath = join(FILES_DIR, name);
    await Bun.write(bookPath, Bun.file(join(FIXTURES_DIR, name)));

    // #when
    const result = await bookSync(bookCreatedEvent(name), deps);

    // #then
    const bookDir = join(DATA_DIR, name);
    const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
    const thumb = await sharp(join(bookDir, "thumb.jpg")).metadata();
    expect({
      cascade: result._unsafeUnwrap(),
      title: entry.includes("<title>Test Book</title>"),
      author: entry.includes("<name>Test Author</name>"),
      issued: entry.includes("<dc:issued>2025</dc:issued>"),
      extent: entry.includes("<dc:extent>3 pages</dc:extent>"),
      cover: entry.includes('rel="http://opds-spec.org/image"'),
      thumbnail: entry.includes('rel="http://opds-spec.org/image/thumbnail"'),
      link: await readlink(join(bookDir, name)),
      thumbFormat: thumb.format,
    }).toEqual({
      cascade: [{ _tag: "FolderMetaSyncRequested", path: DATA_DIR }],
      title: true,
      author: true,
      issued: true,
      extent: true,
      cover: true,
      thumbnail: true,
      link: bookPath,
      thumbFormat: "jpeg",
    });
    await assertCoverMatchesReference(await readFile(join(bookDir, "cover.jpg")));
  });

  test("publishes a DJVU with metadata, cover, thumbnail, download link and a folder refresh", async () => {
    // #given a known source book
    const name = "Test Book - Test Author.djvu";
    const bookPath = join(FILES_DIR, name);
    await Bun.write(bookPath, Bun.file(join(FIXTURES_DIR, name)));

    // #when
    const result = await bookSync(bookCreatedEvent(name), deps);

    // #then
    const bookDir = join(DATA_DIR, name);
    const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
    const thumb = await sharp(join(bookDir, "thumb.jpg")).metadata();
    expect({
      cascade: result._unsafeUnwrap(),
      title: entry.includes("<title>Test Book</title>"),
      author: entry.includes("<name>Test Author</name>"),
      issued: entry.includes("<dc:issued>2025</dc:issued>"),
      subject: entry.includes("<dc:subject>test</dc:subject>"),
      extent: entry.includes("<dc:extent>3 pages</dc:extent>"),
      cover: entry.includes('rel="http://opds-spec.org/image"'),
      thumbnail: entry.includes('rel="http://opds-spec.org/image/thumbnail"'),
      link: await readlink(join(bookDir, name)),
      thumbFormat: thumb.format,
    }).toEqual({
      cascade: [{ _tag: "FolderMetaSyncRequested", path: DATA_DIR }],
      title: true,
      author: true,
      issued: true,
      subject: true,
      extent: true,
      cover: true,
      thumbnail: true,
      link: bookPath,
      thumbFormat: "jpeg",
    });
    await assertCoverMatchesReference(await readFile(join(bookDir, "cover.jpg")));
  });

  test("publishes an EPUB with metadata, cover, thumbnail, download link and a folder refresh", async () => {
    // #given a known EPUB 2 source book
    const name = "Test Book - Test Author.epub";
    const bookPath = join(FILES_DIR, name);
    await Bun.write(bookPath, Bun.file(join(FIXTURES_DIR, name)));

    // #when
    const result = await bookSync(bookCreatedEvent(name), deps);

    // #then
    const bookDir = join(DATA_DIR, name);
    const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
    const thumb = await sharp(join(bookDir, "thumb.jpg")).metadata();
    expect({
      cascade: result._unsafeUnwrap(),
      title: entry.includes("<title>Test Book</title>"),
      author: entry.includes("<name>Test Author</name>"),
      issued: entry.includes("<dc:issued>2021-09</dc:issued>"),
      language: entry.includes("<dc:language>en</dc:language>"),
      cover: entry.includes('rel="http://opds-spec.org/image"'),
      thumbnail: entry.includes('rel="http://opds-spec.org/image/thumbnail"'),
      link: await readlink(join(bookDir, name)),
      thumbFormat: thumb.format,
    }).toEqual({
      cascade: [{ _tag: "FolderMetaSyncRequested", path: DATA_DIR }],
      title: true,
      author: true,
      issued: true,
      language: true,
      cover: true,
      thumbnail: true,
      link: bookPath,
      thumbFormat: "jpeg",
    });
    await assertCoverMatchesReference(await readFile(join(bookDir, "cover.jpg")));
  });

  test("publishes an EPUB packed as a TAR archive with its metadata and cover", async () => {
    // #given the known EPUB's files repacked into a TAR container under an .epub name
    const name = "Tar Packed.epub";
    const contents = join(TEST_DIR, "tar-contents");
    await mkdir(contents, { recursive: true });
    await Bun.$`unzip -q ${join(FIXTURES_DIR, "Test Book - Test Author.epub")} -d ${contents}`.quiet();
    await Bun.$`tar -cf ${join(FILES_DIR, name)} mimetype META-INF content.opf cover.jpeg`.cwd(contents).quiet();

    // #when
    await bookSync(bookCreatedEvent(name), deps);

    // #then
    const bookDir = join(DATA_DIR, name);
    const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
    expect({
      title: entry.includes("<title>Test Book</title>"),
      author: entry.includes("<name>Test Author</name>"),
      issued: entry.includes("<dc:issued>2021-09</dc:issued>"),
      cover: entry.includes('rel="http://opds-spec.org/image"'),
    }).toEqual({ title: true, author: true, issued: true, cover: true });
    await assertCoverMatchesReference(await readFile(join(bookDir, "cover.jpg")));
  });

  test.each(["cbz", "cb7", "cbt"] as const)(
    "publishes a %s comic with merged ComicInfo and CoMet metadata and its hinted cover page",
    async (type) => {
      // #given a comic built from the sample pages, with ComicInfo naming page 1 as front cover and CoMet adding rights
      const name = `Built Comic.${type}`;

      const archive = await buildComic(TEST_DIR, `source.${type}`, type, {
        "ComicInfo.xml": `<ComicInfo><Title>Bobby's Dream</Title><Series>Bobby Make-Believe</Series><Number>3</Number>
          <Writer>Frank King</Writer><LanguageISO>en</LanguageISO><PageCount>4</PageCount>
          <Pages><Page Image="1" Type="FrontCover"/></Pages></ComicInfo>`,
        "CoMet.xml": "<comet><title>Ignored</title><rights>Public domain</rights></comet>",
        [SAMPLE_IMAGES[0]!]: await sampleImage(0),
        [SAMPLE_IMAGES[1]!]: await sampleImage(1),
        [SAMPLE_IMAGES[2]!]: await sampleImage(2),
      });

      await Bun.write(join(FILES_DIR, name), Bun.file(archive));

      // #when
      await bookSync(bookCreatedEvent(name), deps);

      // #then page 1 is the cover: its 975x1320 size is unique among the sample pages and below the cover limit
      const bookDir = join(DATA_DIR, name);
      const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
      const cover = await sharp(join(bookDir, "cover.jpg")).metadata();
      expect({
        title: entry.includes("<title>Bobby's Dream</title>"),
        author: entry.includes("<name>Frank King</name>"),
        series: entry.includes("<dc:isPartOf>Bobby Make-Believe #3</dc:isPartOf>"),
        language: entry.includes("<dc:language>en</dc:language>"),
        extent: entry.includes("<dc:extent>4 pages</dc:extent>"),
        rights: entry.includes("<rights>Public domain</rights>"),
        link: await readlink(join(bookDir, name)),
        cover: { width: cover.width, height: cover.height },
      }).toEqual({
        title: true,
        author: true,
        series: true,
        language: true,
        extent: true,
        rights: true,
        link: join(FILES_DIR, name),
        cover: { width: 975, height: 1320 },
      });
    },
  );

  test("publishes the image-only CBR sample under its filename title with its first page as cover", async () => {
    // #given
    const name = "Bobby_Sample.cbr";
    await Bun.write(join(FILES_DIR, name), Bun.file(join(FIXTURES_DIR, "bobby_make_believe_sample.cbr")));

    // #when
    await bookSync(bookCreatedEvent(name), deps);

    // #then page 0 is the cover: its 975x1349 size is unique among the sample pages and below the cover limit
    const bookDir = join(DATA_DIR, name);
    const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
    const cover = await sharp(join(bookDir, "cover.jpg")).metadata();
    expect({
      title: entry.includes("<title>Bobby Sample</title>"),
      cover: { width: cover.width, height: cover.height },
    }).toEqual({ title: true, cover: { width: 975, height: 1349 } });
  });

  test("uses the filename title when an EPUB has no readable container", async () => {
    // #given a .epub file that is not a ZIP archive
    await Bun.write(join(FILES_DIR, "My_Broken_Novel.epub"), "not an epub");

    // #when
    const result = await bookSync(bookCreatedEvent("My_Broken_Novel.epub"), deps);

    // #then
    const bookDir = join(DATA_DIR, "My_Broken_Novel.epub");
    const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
    expect({
      cascade: result._unsafeUnwrap(),
      title: entry.includes("<title>My Broken Novel</title>"),
      cover: entry.includes('rel="http://opds-spec.org/image"'),
      link: await readlink(join(bookDir, "My_Broken_Novel.epub")),
    }).toEqual({
      cascade: [{ _tag: "FolderMetaSyncRequested", path: DATA_DIR }],
      title: true,
      cover: false,
      link: join(FILES_DIR, "My_Broken_Novel.epub"),
    });
  });

  test.each(["Test Book - Test Author.mobi", "Test Book - Test Author.azw3"])(
    "publishes %s with metadata, embedded cover, thumbnail, download link and a folder refresh",
    async (name) => {
      // #given a known source book
      const bookPath = join(FILES_DIR, name);
      await Bun.write(bookPath, Bun.file(join(FIXTURES_DIR, name)));

      // #when
      const result = await bookSync(bookCreatedEvent(name), deps);

      // #then
      const bookDir = join(DATA_DIR, name);
      const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
      const thumb = await sharp(join(bookDir, "thumb.jpg")).metadata();
      expect({
        cascade: result._unsafeUnwrap(),
        title: entry.includes("<title>Test Book</title>"),
        author: entry.includes("<name>Test Author</name>"),
        cover: entry.includes('rel="http://opds-spec.org/image"'),
        thumbnail: entry.includes('rel="http://opds-spec.org/image/thumbnail"'),
        link: await readlink(join(bookDir, name)),
        thumbFormat: thumb.format,
      }).toEqual({
        cascade: [{ _tag: "FolderMetaSyncRequested", path: DATA_DIR }],
        title: true,
        author: true,
        cover: true,
        thumbnail: true,
        link: bookPath,
        thumbFormat: "jpeg",
      });
      await assertCoverMatchesReference(await readFile(join(bookDir, "cover.jpg")));
    },
  );

  test("publishes a TXT book under its filename title without a cover", async () => {
    // #given
    const name = "My_Plain_Notes.txt";
    const bookPath = join(FILES_DIR, name);
    await Bun.write(bookPath, Bun.file(join(FIXTURES_DIR, "sample_text.txt")));

    // #when
    const result = await bookSync(bookCreatedEvent(name), deps);

    // #then
    const bookDir = join(DATA_DIR, name);
    const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
    expect({
      cascade: result._unsafeUnwrap(),
      title: entry.includes("<title>My Plain Notes</title>"),
      cover: entry.includes('rel="http://opds-spec.org/image"'),
      link: await readlink(join(bookDir, name)),
    }).toEqual({
      cascade: [{ _tag: "FolderMetaSyncRequested", path: DATA_DIR }],
      title: true,
      cover: false,
      link: bookPath,
    });
  });

  test("uses the filename title when a MOBI header is unreadable", async () => {
    // #given a file that is not a PalmDB book
    await Bun.write(join(FILES_DIR, "Broken_Kindle_Book.azw3"), "not a mobi");

    // #when
    await bookSync(bookCreatedEvent("Broken_Kindle_Book.azw3"), deps);

    // #then
    const entry = await readFile(join(DATA_DIR, "Broken_Kindle_Book.azw3", "entry.xml"), "utf-8");
    expect(entry.includes("<title>Broken Kindle Book</title>")).toBe(true);
  });

  test.each(["Test Book - Test Author.fb2", "Test Book - Test Author.fbz"])(
    "publishes %s with metadata, cover, thumbnail, download link and a folder refresh",
    async (name) => {
      // #given a known plain or archived FB2 source book
      const bookPath = join(FILES_DIR, name);
      await Bun.write(bookPath, Bun.file(join(FIXTURES_DIR, name)));

      // #when
      const result = await bookSync(bookCreatedEvent(name), deps);

      // #then
      const bookDir = join(DATA_DIR, name);
      const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
      const thumb = await sharp(join(bookDir, "thumb.jpg")).metadata();
      expect({
        cascade: result._unsafeUnwrap(),
        title: entry.includes("<title>Test Book</title>"),
        author: entry.includes("<name>Test Author</name>"),
        language: entry.includes("<dc:language>en</dc:language>"),
        cover: entry.includes('rel="http://opds-spec.org/image"'),
        thumbnail: entry.includes('rel="http://opds-spec.org/image/thumbnail"'),
        link: await readlink(join(bookDir, name)),
        thumbFormat: thumb.format,
      }).toEqual({
        cascade: [{ _tag: "FolderMetaSyncRequested", path: DATA_DIR }],
        title: true,
        author: true,
        language: true,
        cover: true,
        thumbnail: true,
        link: bookPath,
        thumbFormat: "jpeg",
      });
      await assertCoverMatchesReference(await readFile(join(bookDir, "cover.jpg")));
    },
  );

  test("uses the filename title when an FBZ is not a readable archive", async () => {
    // #given an .fbz file that is no archive
    await Bun.write(join(FILES_DIR, "My_Broken_Tale.fbz"), "not an archive");

    // #when
    const result = await bookSync(bookCreatedEvent("My_Broken_Tale.fbz"), deps);

    // #then
    const bookDir = join(DATA_DIR, "My_Broken_Tale.fbz");
    const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
    expect({
      cascade: result._unsafeUnwrap(),
      title: entry.includes("<title>My Broken Tale</title>"),
      cover: entry.includes('rel="http://opds-spec.org/image"'),
      link: await readlink(join(bookDir, "My_Broken_Tale.fbz")),
    }).toEqual({
      cascade: [{ _tag: "FolderMetaSyncRequested", path: DATA_DIR }],
      title: true,
      cover: false,
      link: join(FILES_DIR, "My_Broken_Tale.fbz"),
    });
  });

  /** Holds `Bun.file(path)[method]()` until `release()`, so a stop can arrive while the read is running. */
  function holdBookRead(path: string, method: "arrayBuffer" | "exists" | "text") {
    const originalFile = Bun.file.bind(Bun);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();

    // SAFETY: the mock takes the string-path overload the extractors call and returns the real BunFile for it.
    const fileSpy = spyOn(Bun, "file").mockImplementation(((target: string, options?: BlobPropertyBag) => {
      const file = originalFile(target, options);

      if (target !== path) return file;

      if (method === "exists") {
        const exists = file.exists.bind(file);
        file.exists = () => {
          markStarted();

          return gate.then(exists);
        };
      } else if (method === "text") {
        const text = file.text.bind(file);
        file.text = () => {
          markStarted();

          return gate.then(text);
        };
      } else {
        const arrayBuffer = file.arrayBuffer.bind(file);
        file.arrayBuffer = () => {
          markStarted();

          return gate.then(arrayBuffer);
        };
      }

      return file;
    }) as typeof Bun.file);

    return { started, release: () => release(), restore: () => fileSpy.mockRestore() };
  }

  test.each([
    { name: "Held.mobi", source: "Test Book - Test Author.mobi", method: "arrayBuffer" as const },
    { name: "Held.txt", source: "sample_text.txt", method: "exists" as const },
    { name: "Held.fb2", source: "Test Book - Test Author.fb2", method: "text" as const },
  ])("a stop during the $name read waits for the read and publishes nothing", async ({ name, source, method }) => {
    // #given a book with a previous entry whose source read is running
    const bookPath = join(FILES_DIR, name);
    const bookDir = join(DATA_DIR, name);
    await Bun.write(bookPath, Bun.file(join(FIXTURES_DIR, source)));
    await mkdir(bookDir);
    await Bun.write(join(bookDir, "entry.xml"), "previous entry");
    const held = holdBookRead(bookPath, method);
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const stoppableDeps: TestHandlerDeps = { ...deps, signal: controller.signal };

    try {
      const result = bookSync(bookCreatedEvent(name), stoppableDeps);
      await held.started;

      // #when the stop arrives mid-read
      controller.abort(reason);
      const beforeRelease = await Promise.race([result.then(() => "settled"), Bun.sleep(100).then(() => "waiting")]);
      held.release();
      const outcome = await result;

      // #then the handler waited for the read, ended as stopped, and left the previous entry without a link
      expect({
        beforeRelease,
        error: outcome._unsafeUnwrapErr(),
        entry: await Bun.file(join(bookDir, "entry.xml")).text(),
        linkExists: await lstat(join(bookDir, name)).then(
          () => true,
          () => false,
        ),
      }).toEqual({ beforeRelease: "waiting", error: reason, entry: "previous entry", linkExists: false });
    } finally {
      held.release();
      held.restore();
    }
  });

  const PDF_INFO = `Title:          Cover Failure Metadata
Author:         PDF Author
Pages:          7
`;

  async function syncPdfWithFailingCover(): Promise<string> {
    await Bun.write(join(FILES_DIR, "metadata.pdf"), "fake pdf");
    await bookSync(bookCreatedEvent("metadata.pdf"), deps);

    return readFile(join(DATA_DIR, "metadata.pdf", "entry.xml"), "utf-8");
  }

  function coverFailureView(entry: string) {
    return {
      title: entry.includes("<title>Cover Failure Metadata</title>"),
      author: entry.includes("<name>PDF Author</name>"),
      extent: entry.includes("<dc:extent>7 pages</dc:extent>"),
      cover: entry.includes('rel="http://opds-spec.org/image"'),
      thumbnail: entry.includes('rel="http://opds-spec.org/image/thumbnail"'),
    };
  }

  const KEPT_METADATA_WITHOUT_COVER = { title: true, author: true, extent: true, cover: false, thumbnail: false };

  test("keeps PDF metadata when the cover command fails to spawn", async () => {
    // #given
    mockPdfInfo(PDF_INFO);
    mockPdfToPpmSpawnFailure(new Error("pdftoppm missing"));

    // #when
    const entry = await syncPdfWithFailingCover();

    // #then
    expect(coverFailureView(entry)).toEqual(KEPT_METADATA_WITHOUT_COVER);
  });

  test("keeps PDF metadata when the cover command exits nonzero", async () => {
    // #given
    mockPdfInfo(PDF_INFO);
    mockPdfToPpmExit(99);

    // #when
    const entry = await syncPdfWithFailingCover();

    // #then
    expect(coverFailureView(entry)).toEqual(KEPT_METADATA_WITHOUT_COVER);
  });

  test("keeps PDF metadata when the cover command times out", async () => {
    // #given a cover command that runs until the 15 s command timeout kills it
    mockPdfInfo(PDF_INFO);
    mockPdfToPpmHangUntilKilled();

    // #when
    const entry = await syncPdfWithFailingCover();

    // #then
    expect(coverFailureView(entry)).toEqual(KEPT_METADATA_WITHOUT_COVER);
  }, 25_000);

  test("uses the filename title when a PDF has no readable metadata", async () => {
    // #given a file pdfinfo rejects
    await Bun.write(join(FILES_DIR, "My_Broken_Report.pdf"), "not a pdf");

    // #when
    const result = await bookSync(bookCreatedEvent("My_Broken_Report.pdf"), deps);

    // #then
    const bookDir = join(DATA_DIR, "My_Broken_Report.pdf");
    const entry = await readFile(join(bookDir, "entry.xml"), "utf-8");
    expect({
      cascade: result._unsafeUnwrap(),
      title: entry.includes("<title>My Broken Report</title>"),
      cover: entry.includes('rel="http://opds-spec.org/image"'),
      link: await readlink(join(bookDir, "My_Broken_Report.pdf")),
    }).toEqual({
      cascade: [{ _tag: "FolderMetaSyncRequested", path: DATA_DIR }],
      title: true,
      cover: false,
      link: join(FILES_DIR, "My_Broken_Report.pdf"),
    });
  });

  test("handles nested folder structure", async () => {
    const nestedPath = join(FILES_DIR, "Fiction", "Author");
    await mkdir(nestedPath, { recursive: true });
    const bookPath = join(nestedPath, "book.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("Fiction/Author/book.epub"), deps);

    const dataDir = join(DATA_DIR, "Fiction", "Author", "book.epub");

    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(true);
  });

  test("uses filename as title when metadata unavailable", async () => {
    const bookPath = join(FILES_DIR, "My_Great_Book.epub");
    await Bun.write(bookPath, "fake epub content");

    await bookSync(bookCreatedEvent("My_Great_Book.epub"), deps);

    const entryPath = join(DATA_DIR, "My_Great_Book.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");
    expect(entryContent).toContain("My Great Book");
  });
});
