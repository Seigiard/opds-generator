import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../../src/context.ts";
import { orphanedOutputs } from "../../../src/lifecycle/orphans.ts";
import { ENTRY_FILE, FOLDER_ENTRY_FILE } from "../../../src/constants.ts";
import type { EventType } from "../../../src/processing/types.ts";

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "opds-orphans-"));
  const sourcePath = join(root, "source");
  const outputPath = join(root, "output");
  await mkdir(sourcePath);
  await mkdir(outputPath);
  const ctx = await buildContext();

  return {
    root,
    sourcePath,
    outputPath,
    deps: { ...ctx, config: { ...ctx.config, filesPath: sourcePath, dataPath: outputPath, reconcileInterval: 0 } },
  };
}

function deletionSummary(event: EventType) {
  if (event._tag === "BookDeleted" || event._tag === "FolderDeleted") {
    return { tag: event._tag, parent: event.parent, name: event.name };
  }

  return { tag: event._tag };
}

test("a stale folder marker is cleanup work even when a same-path book marker exists", async () => {
  // #given output that contains both the old folder marker and the current book marker
  const { root, sourcePath, outputPath, deps } = await tree();
  const output = join(outputPath, "Novel.fb2");
  await mkdir(output);
  await Bun.write(join(output, FOLDER_ENTRY_FILE), "folder");
  await Bun.write(join(output, ENTRY_FILE), "book");

  try {
    // #when the source scan contains a book at that path and no folder at that path
    const work = await Effect.runPromise(orphanedOutputs(deps, [{ path: "Novel.fb2", kind: "file", size: 1, mtimeMs: 1 }]));

    // #then cleanup retries the obsolete folder representation
    expect(work.map(deletionSummary)).toEqual([{ tag: "FolderDeleted", parent: sourcePath, name: "Novel.fb2" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parent folder deletion declares descendant output deletions before the parent", async () => {
  // #given a removed source tree whose output still has a child book and parent folder marker
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(outputPath, "Fiction", "Book.fb2"), { recursive: true });
  await Bun.write(join(outputPath, "Fiction", FOLDER_ENTRY_FILE), "folder");
  await Bun.write(join(outputPath, "Fiction", "Book.fb2", ENTRY_FILE), "book");

  try {
    // #when the source scan is empty
    const work = await Effect.runPromise(orphanedOutputs(deps, []));

    // #then child cleanup can clear child retained failures before the parent removal deletes its subtree
    expect(work.map(deletionSummary)).toEqual([
      { tag: "BookDeleted", parent: join(sourcePath, "Fiction"), name: "Book.fb2" },
      { tag: "FolderDeleted", parent: sourcePath, name: "Fiction" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
