import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../../src/effect/services.ts";
import { folderMetaSync } from "../../../../src/effect/handlers/folder-meta-sync.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `opds-folder-meta-test-${Date.now()}`);
const DATA_DIR = join(TEST_DIR, "data");

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string; meta?: Record<string, unknown> }>,
  warnCalls: [] as Array<{ tag: string; msg: string }>,
  reset() {
    this.infoCalls = [];
    this.warnCalls = [];
  },
};

const TestConfigService = Layer.succeed(ConfigService, {
  filesPath: join(TEST_DIR, "files"),
  dataPath: DATA_DIR,
  baseUrl: "http://localhost:8080",
  port: 3000,
});

const TestLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg, meta) =>
    Effect.sync(() => {
      mockLogger.infoCalls.push({ tag, msg, meta });
    }),
  warn: (tag, msg) =>
    Effect.sync(() => {
      mockLogger.warnCalls.push({ tag, msg });
    }),
  error: () => Effect.void,
  debug: () => Effect.void,
});

const RealFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: (path, options) => Effect.promise(() => mkdir(path, options)),
  rm: (path, options) => Effect.promise(() => rm(path, options)),
  readdir: (path) =>
    Effect.promise(async () => {
      const fs = await import("node:fs/promises");
      return fs.readdir(path);
    }),
  stat: (path) =>
    Effect.promise(async () => {
      const s = await stat(path);
      return { isDirectory: () => s.isDirectory(), size: s.size };
    }),
  exists: (path) =>
    Effect.promise(async () => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    }),
  writeFile: (path, content) => Effect.promise(() => Bun.write(path, content)),
  atomicWrite: (path, content) => Effect.promise(() => Bun.write(path, content)),
  symlink: () => Effect.void,
  unlink: () => Effect.void,
});

const TestLayer = Layer.mergeAll(TestConfigService, TestLoggerService, RealFileSystemService);

const folderMetaSyncEvent = (path: string): EventType => ({
  _tag: "FolderMetaSyncRequested",
  path,
});

describe("folderMetaSync handler", () => {
  beforeEach(async () => {
    mockLogger.reset();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(DATA_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("returns empty array for non-FolderMetaSyncRequested events", async () => {
    const event: EventType = { _tag: "BookCreated", parent: DATA_DIR, name: "book.epub" };
    const cascades = await Effect.runPromise(Effect.provide(folderMetaSync(event), TestLayer));

    expect(cascades).toEqual([]);
  });

  test("creates feed.xml in empty folder", async () => {
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const feedPath = join(DATA_DIR, "feed.xml");
    const exists = await stat(feedPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("includes XML declaration and stylesheet", async () => {
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const feedPath = join(DATA_DIR, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain('<?xml version="1.0"');
    expect(content).toContain('<?xml-stylesheet href="/static/layout.xsl"');
  });

  test("sets feed as navigation type for empty folder", async () => {
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const feedPath = join(DATA_DIR, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain("kind=navigation");
  });

  test("includes self link in feed", async () => {
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const feedPath = join(DATA_DIR, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain('rel="self"');
    expect(content).toContain("/feed.xml");
  });

  test("includes start link in feed", async () => {
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const feedPath = join(DATA_DIR, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain('rel="start"');
  });

  test("includes folder entries from subfolders", async () => {
    const subfolderPath = join(DATA_DIR, "Fiction");
    await mkdir(subfolderPath, { recursive: true });
    await Bun.write(join(subfolderPath, "_entry.xml"), '<entry xmlns="http://www.w3.org/2005/Atom"><title>Fiction</title></entry>');

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const feedPath = join(DATA_DIR, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain("<title>Fiction</title>");
  });

  test("includes book entries from subfolders", async () => {
    const bookPath = join(DATA_DIR, "book.epub");
    await mkdir(bookPath, { recursive: true });
    await Bun.write(join(bookPath, "entry.xml"), '<entry xmlns="http://www.w3.org/2005/Atom"><title>Test Book</title></entry>');

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const feedPath = join(DATA_DIR, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain("<title>Test Book</title>");
  });

  test("sets feed as acquisition type when books present", async () => {
    const bookPath = join(DATA_DIR, "book.epub");
    await mkdir(bookPath, { recursive: true });
    await Bun.write(join(bookPath, "entry.xml"), '<entry xmlns="http://www.w3.org/2005/Atom"><title>Book</title></entry>');

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const feedPath = join(DATA_DIR, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain("kind=acquisition");
  });

  test("sorts entries naturally", async () => {
    const items = ["item10", "item2", "item1"];
    for (const item of items) {
      const itemPath = join(DATA_DIR, item);
      await mkdir(itemPath, { recursive: true });
      await Bun.write(join(itemPath, "_entry.xml"), `<entry xmlns="http://www.w3.org/2005/Atom"><title>${item}</title></entry>`);
    }

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const feedPath = join(DATA_DIR, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    const item1Pos = content.indexOf("item1</title>");
    const item2Pos = content.indexOf("item2</title>");
    const item10Pos = content.indexOf("item10</title>");

    expect(item1Pos).toBeLessThan(item2Pos);
    expect(item2Pos).toBeLessThan(item10Pos);
  });

  test("logs processing info", async () => {
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    expect(mockLogger.infoCalls.some((c) => c.tag === "FolderMetaSync" && c.msg.includes("Processing"))).toBe(true);
    expect(mockLogger.infoCalls.some((c) => c.tag === "FolderMetaSync" && c.msg.includes("Generated"))).toBe(true);
  });

  test("handles nested folder path", async () => {
    const nestedPath = join(DATA_DIR, "Fiction", "SciFi");
    await mkdir(nestedPath, { recursive: true });

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(nestedPath)), TestLayer));

    const feedPath = join(nestedPath, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain("SciFi");
    expect(content).toContain('href="/Fiction/SciFi/feed.xml"');
  });
});
