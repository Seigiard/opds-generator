import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLegacyHeapSnapshots } from "../../src/lifecycle/legacy-data.ts";

describe("removeLegacyHeapSnapshots", () => {
  test("deletes the snapshots old builds left in /data and keeps the catalogue", async () => {
    // #given
    const dataPath = await mkdtemp(join(tmpdir(), "opds-snapshots-"));
    await Bun.write(join(dataPath, "heap-snapshot-100.json"), "{}");
    await Bun.write(join(dataPath, "heap-snapshot-3000.json"), "{}");
    await Bun.write(join(dataPath, "feed.xml"), "<feed/>");
    await mkdir(join(dataPath, "Author"));

    // #when
    await removeLegacyHeapSnapshots(dataPath);

    // #then
    expect((await readdir(dataPath)).sort()).toEqual(["Author", "feed.xml"]);
    await rm(dataPath, { recursive: true, force: true });
  });

  test("does nothing when the data directory does not exist yet", async () => {
    // #given
    const dataPath = join(tmpdir(), `opds-missing-${crypto.randomUUID()}`);

    // #when
    const removed = await removeLegacyHeapSnapshots(dataPath);

    // #then
    expect(removed).toEqual([]);
  });
});
