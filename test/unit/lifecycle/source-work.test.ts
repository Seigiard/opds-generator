import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSourcePath, OutputCleanupFailed, SourceObservationFailed, type OutputCleanup } from "@seigiard/sync-engine";
import type { HandlerDeps } from "../../../src/context.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService } from "../../../src/effect-file-system.ts";
import { engineOptions } from "../../../src/lifecycle/initial-engine-catalogue.ts";
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

function cleanupOutput(dataPath: string, calls: string[][]): OutputCleanup {
  return (outputs) =>
    Effect.tryPromise({
      try: async () => {
        calls.push([...outputs]);
        await Promise.all(outputs.map((output) => rm(join(dataPath, output), { recursive: true, force: true })));

        return true;
      },
      catch: (cause) => new OutputCleanupFailed({ path: dataPath, cause, message: String(cause) }),
    }).pipe(Effect.uninterruptible);
}

test("source-kind replacement delegates obsolete book output cleanup to the engine session", async () => {
  // #given a source folder that replaced a published book and an engine-session cleanup capability
  const root = await mkdtemp(join(tmpdir(), "opds-source-work-"));
  const filesPath = join(root, "source");
  const dataPath = join(root, "output");
  await mkdir(filesPath);
  await mkdir(dataPath);
  await mkdir(join(filesPath, "Book.fb2"));
  await mkdir(join(dataPath, "Book.fb2"));
  const calls: string[][] = [];
  const deps = handlerDeps(filesPath, dataPath);

  try {
    // #when source work receives the old book deletion through the engine handler seam
    const cascade = await Effect.runPromise(
      engineOptions(deps)
        .handle(CatalogueEvent.BookDeleted({ parent: filesPath, name: "Book.fb2" }), cleanupOutput(dataPath, calls))
        .pipe(
          Effect.provideService(CatalogueDeps, deps),
          Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
        ),
    );

    // #then only the session capability removes the obsolete projection and requests the parent publication
    expect({ calls, cascade, staleOutput: await pathExists(join(dataPath, "Book.fb2")) }).toEqual({
      calls: [["Book.fb2"]],
      cascade: [CatalogueEvent.FolderMetaSyncRequested({ path: dataPath })],
      staleOutput: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported source-kind replacement delegates obsolete output cleanup to the engine session", async () => {
  // #given a source symlink replacement and an engine-session cleanup capability
  const root = await mkdtemp(join(tmpdir(), "opds-source-work-"));
  const filesPath = join(root, "source");
  const dataPath = join(root, "output");
  const external = join(root, "external-source");
  await mkdir(filesPath);
  await mkdir(dataPath);
  await mkdir(external);
  await mkdir(join(dataPath, "Book.fb2"));
  await symlink(external, join(filesPath, "Book.fb2"));
  const calls: string[][] = [];
  const deps = handlerDeps(filesPath, dataPath);

  try {
    // #when source work receives the old book deletion through the engine handler seam
    const cascade = await Effect.runPromise(
      engineOptions(deps)
        .handle(CatalogueEvent.BookDeleted({ parent: filesPath, name: "Book.fb2" }), cleanupOutput(dataPath, calls))
        .pipe(
          Effect.provideService(CatalogueDeps, deps),
          Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
        ),
    );

    // #then the typed unsupported observation removes the stale projection through the session capability
    expect({ calls, cascade, staleOutput: await pathExists(join(dataPath, "Book.fb2")) }).toEqual({
      calls: [["Book.fb2"]],
      cascade: [CatalogueEvent.FolderMetaSyncRequested({ path: dataPath })],
      staleOutput: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observation faults with an unsupported-path message retain stale output", async () => {
  // #given an unreadable parent that reports the old unsupported-source message without its typed reason
  const root = await mkdtemp(join(tmpdir(), "opds-source-work-"));
  const filesPath = join(root, "source");
  const dataPath = join(root, "output");
  await mkdir(filesPath);
  await mkdir(dataPath);
  await mkdir(join(dataPath, "Book.fb2"));
  const deps = handlerDeps(filesPath, dataPath, () => Promise.reject(new Error("Unsupported source path")));

  try {
    // #when a deletion event cannot authoritatively observe its missing source
    const exit = await Effect.runPromiseExit(
      engineOptions(deps)
        .handle(CatalogueEvent.BookDeleted({ parent: filesPath, name: "Book.fb2" }))
        .pipe(
          Effect.provideService(CatalogueDeps, deps),
          Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
        ),
    );

    // #then message text cannot authorize cleanup
    expect({ exit: exit._tag, staleOutput: await pathExists(join(dataPath, "Book.fb2")) }).toEqual({
      exit: "Failure",
      staleOutput: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public engine source-observation exports compose with the consumer Effect runtime", async () => {
  // #given a real source root with an unsupported child symlink
  const root = await mkdtemp(join(tmpdir(), "opds-source-work-"));
  const filesPath = join(root, "source");
  const external = join(root, "external-source");
  await mkdir(filesPath);
  await mkdir(external);
  await symlink(external, join(filesPath, "Book.fb2"));

  try {
    // #when the application runs the package-root observation export with its Effect runtime
    const observation = await Effect.runPromise(
      observeSourcePath(filesPath, "Book.fb2").pipe(
        Effect.match({
          onFailure: (error) => ({ error: error instanceof SourceObservationFailed, reason: error.reason }),
          onSuccess: () => ({ error: false, reason: undefined }),
        }),
      ),
    );

    // #then the public API supplies the structured unsupported-path reason
    expect(observation).toEqual({ error: true, reason: "unsupported-path" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function handlerDeps(filesPath: string, dataPath: string, readdir: (path: string) => Promise<string[]> = async () => []): HandlerDeps {
  return {
    config: { filesPath, dataPath, port: 3000, reconcileInterval: 0 },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    fs: {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      rm,
      readdir,
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
}
