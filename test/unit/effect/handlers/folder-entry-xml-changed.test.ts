import { describe, test, expect } from "bun:test";
import { folderEntryXmlChanged } from "../../../../src/effect/handlers/folder-entry-xml-changed.ts";
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

const folderEntryXmlChangedEvent = (parent: string): EventType => ({
  _tag: "FolderEntryXmlChanged",
  parent,
});

describe("folderEntryXmlChanged handler", () => {
  test("returns empty array for non-FolderEntryXmlChanged events", async () => {
    // #given
    const event: EventType = { _tag: "BookCreated", parent: "/files", name: "book.epub" };

    // #when
    const result = await folderEntryXmlChanged(event, deps);

    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("returns two FolderMetaSyncRequested events (current and parent)", async () => {
    // #when
    const result = await folderEntryXmlChanged(folderEntryXmlChangedEvent("/data/Fiction/Author"), deps);

    // #then
    expect(result.isOk()).toBe(true);
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(2);
    expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction/Author" });
    expect(cascades[1]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction" });
  });

  test("returns root as parent when folder is top-level", async () => {
    // #when
    const result = await folderEntryXmlChanged(folderEntryXmlChangedEvent("/data/Fiction"), deps);

    // #then
    expect(result.isOk()).toBe(true);
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(2);
    expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction" });
    expect(cascades[1]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data" });
  });

  test("handles deeply nested folders", async () => {
    // #when
    const result = await folderEntryXmlChanged(folderEntryXmlChangedEvent("/data/Fiction/SciFi/Author"), deps);

    // #then
    expect(result.isOk()).toBe(true);
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(2);
    expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction/SciFi/Author" });
    expect(cascades[1]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction/SciFi" });
  });

  test("handles trailing slash in path", async () => {
    // #when
    const result = await folderEntryXmlChanged(folderEntryXmlChangedEvent("/data/Fiction/Author/"), deps);

    // #then
    expect(result.isOk()).toBe(true);
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(2);
    expect((cascades[0] as { _tag: "FolderMetaSyncRequested"; path: string }).path).toBe("/data/Fiction/Author");
  });
});
