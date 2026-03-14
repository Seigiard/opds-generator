import { describe, test, expect } from "bun:test";
import { parentMetaSync } from "../../../../src/effect/handlers/parent-meta-sync.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/effect/types.ts";

const deps: HandlerDeps = {
  config: { filesPath: "/files", dataPath: "/data", port: 3000, reconcileInterval: 1800 },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fs: {
    mkdir: async () => {},
    rm: async () => {},
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => false, size: 0 }),
    exists: async () => false,
    writeFile: async () => {},
    atomicWrite: async () => {},
    symlink: async () => {},
    unlink: async () => {},
  },
};

const entryXmlChangedEvent = (parent: string): EventType => ({
  _tag: "EntryXmlChanged",
  parent,
});

describe("parentMetaSync handler", () => {
  test("returns empty array for non-EntryXmlChanged events", async () => {
    // #given
    const event: EventType = { _tag: "BookCreated", parent: "/files", name: "book.epub" };

    // #when
    const result = await parentMetaSync(event, deps);

    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("returns FolderMetaSyncRequested for parent directory", async () => {
    // #when
    const result = await parentMetaSync(entryXmlChangedEvent("/data/Fiction/Author"), deps);

    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
    expect(result._unsafeUnwrap()[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction",
    });
  });

  test("returns FolderMetaSyncRequested for root when parent is root", async () => {
    // #when
    const result = await parentMetaSync(entryXmlChangedEvent("/data/Fiction"), deps);

    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
    expect(result._unsafeUnwrap()[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data",
    });
  });

  test("handles trailing slash in path", async () => {
    // #when
    const result = await parentMetaSync(entryXmlChangedEvent("/data/Fiction/Author/"), deps);

    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
    expect(result._unsafeUnwrap()[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction",
    });
  });
});
