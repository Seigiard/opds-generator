import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandlerDeps } from "../../../src/context.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService } from "../../../src/effect-file-system.ts";
import { engineSourceWork } from "../../../src/lifecycle/engine-source-work.ts";
import { CatalogueDeps } from "../../../src/processing/effect-handler.ts";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;

    throw error;
  }
}

test("unsupported source replacement cleanup is decided through source work", async () => {
  // #given a source symlink replacement and a stale OPDS output
  const root = await mkdtemp(join(tmpdir(), "opds-source-work-"));
  const filesPath = join(root, "source");
  const dataPath = join(root, "output");
  const external = join(root, "external-source");
  await mkdir(filesPath);
  await mkdir(dataPath);
  await mkdir(external);
  await mkdir(join(dataPath, "Book.fb2"));
  await symlink(external, join(filesPath, "Book.fb2"));

  const deps: HandlerDeps = {
    config: { filesPath, dataPath, port: 3000, reconcileInterval: 0 },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    fs: {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      rm,
      readdir: async () => [],
      stat: async (path) => {
        const info = await stat(path);

        return { isDirectory: () => info.isDirectory(), size: info.size };
      },
      exists: pathExists,
      writeFile: async () => undefined,
      atomicWrite: async () => undefined,
      symlink: async () => undefined,
      unlink: async () => undefined,
    },
  };

  try {
    // #when a deletion event re-observes the unsupported source path
    const cascade = await Effect.runPromise(
      engineSourceWork(deps, CatalogueEvent.BookDeleted({ parent: filesPath, name: "Book.fb2" }), undefined).pipe(
        Effect.provideService(CatalogueDeps, deps),
        Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
      ),
    );

    // #then OPDS removes its stale output and refreshes the root folder
    expect({ cascade, staleOutput: await pathExists(join(dataPath, "Book.fb2")) }).toEqual({
      cascade: [CatalogueEvent.FolderMetaSyncRequested({ path: dataPath })],
      staleOutput: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
