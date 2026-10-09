import {
  engineStatePath,
  nativeSourceFileSystem,
  observeSourcePath,
  readSourceDirectory,
  removeAssociatedOutputs,
} from "@seigiard/sync-engine";
import { Effect, Predicate } from "effect";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { CatalogueEvent, type EffectHandler } from "../processing/effect-handler.ts";
import type { EventType } from "../processing/types.ts";
import { catalogueStatePath, includeCatalogueSource } from "./engine-policy.ts";

export function engineSourceWork(deps: HandlerDeps, event: EventType, handler: EffectHandler | undefined) {
  return Effect.gen(function* () {
    if (Predicate.isTagged(event, "Ignored")) return [];
    const { filesPath, dataPath } = deps.config;

    const path = Predicate.isTagged(event, "FolderMetaSyncRequested")
      ? relative(dataPath, event.path)
      : relative(filesPath, join(event.parent, event.name));

    if (!includeCatalogueSource(path)) return [];

    const deleted = Predicate.isTagged(event, "BookDeleted") || Predicate.isTagged(event, "FolderDeleted");
    const sourceFs = { ...nativeSourceFileSystem, readdir: (source: string) => deps.fs.readdir(source) };
    let unsupportedSourceReplacement = false;

    const observation = yield* observeSourcePath(filesPath, path, sourceFs).pipe(
      Effect.catchTag("SourceObservationFailed", (error) => {
        if (deleted && error.message.includes("Unsupported source path")) {
          unsupportedSourceReplacement = true;

          return Effect.succeed({ state: "absent" } as const);
        }

        return Effect.fail(error);
      }),
    );

    if (observation.state === "absent") {
      const removed = unsupportedSourceReplacement
        ? yield* removeOutputPath(deps, path)
        : yield* removeAssociatedOutputs(
            {
              sourcePath: filesPath,
              outputPath: dataPath,
              statePath: catalogueStatePath(dataPath),
              sourceRelativePath: path,
              outputs: [path],
            },
            sourceFs,
          );

      return removed ? [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(join(dataPath, path)) })] : [];
    }

    if (deleted) {
      const obsoleteBook = Predicate.isTagged(event, "BookDeleted") && observation.entry.kind === "directory";
      const obsoleteFolder = Predicate.isTagged(event, "FolderDeleted") && observation.entry.kind === "file";

      if (!obsoleteBook && !obsoleteFolder) return [];

      const removed = yield* removeOutputPath(deps, path);

      return removed ? [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(join(dataPath, path)) })] : [];
    }

    if (observation.entry.kind === "directory") yield* readSourceDirectory(filesPath, path, sourceFs);

    if (!handler) {
      return yield* Effect.fail(new Error(`Unsupported engine work: ${event._tag}`));
    }

    return yield* handler(event);
  }).pipe(Effect.uninterruptible);
}

function removeOutputPath(deps: HandlerDeps, output: string): Effect.Effect<boolean, Error> {
  return Effect.tryPromise({
    try: async () => {
      const root = await realpath(deps.config.dataPath);
      const state = await Effect.runPromise(engineStatePath(deps.config.dataPath, catalogueStatePath(deps.config.dataPath)));
      const path = confinedPath(root, output);

      if (overlaps(path, state) || overlaps(state, path)) throw new Error("OPDS cleanup overlaps engine state");

      let current = root;

      for (const component of relative(root, dirname(path)).split(sep).filter(Boolean)) {
        current = join(current, component);
        const info = await lstat(current);

        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("OPDS cleanup ancestor is not an owned directory");
      }

      const existed = await deps.fs.exists(path);

      if (existed) await deps.fs.rm(path, { recursive: true });

      return existed;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.uninterruptible);
}

function confinedPath(root: string, path: string): string {
  if (isAbsolute(path) || path.split(sep).includes("..")) throw new Error("Expected a confined relative path");
  const absolute = resolve(root, path);
  const within = relative(root, absolute);

  if (within === "" || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) {
    throw new Error("Path leaves its owned tree");
  }

  return absolute;
}

function overlaps(parent: string, child: string): boolean {
  const within = relative(parent, child);

  return within === "" || (within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within));
}
