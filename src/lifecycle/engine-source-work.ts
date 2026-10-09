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
        if (deleted && isObsoleteSourceReplacement(error)) {
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

      if (unsupportedSourceReplacement) {
        const parent = dirname(path);
        const unsupportedParent = parent !== "." && (yield* isNonDirectorySourcePath(filesPath, parent, sourceFs));

        if (unsupportedParent) return [];
      }

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

const OBSOLETE_SOURCE_REPLACEMENT_MESSAGES = new Set(["Unsupported source path", "Source ancestor is not a directory"]);

export function isObsoleteSourceReplacement(error: { readonly message: string }): boolean {
  return OBSOLETE_SOURCE_REPLACEMENT_MESSAGES.has(error.message);
}

function isNonDirectorySourcePath(sourcePath: string, path: string, sourceFs: typeof nativeSourceFileSystem): Effect.Effect<boolean> {
  return observeSourcePath(sourcePath, path, sourceFs).pipe(
    Effect.match({
      onFailure: (error) => isObsoleteSourceReplacement(error),
      onSuccess: (observation) => observation.state === "present" && observation.entry.kind !== "directory",
    }),
  );
}

function overlaps(parent: string, child: string): boolean {
  const path = relative(parent, child);

  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

function removeOutputPath(deps: HandlerDeps, output: string): Effect.Effect<boolean, Error> {
  return Effect.tryPromise({
    try: async () => {
      const root = await realpath(deps.config.dataPath);
      const state = await Effect.runPromise(engineStatePath(deps.config.dataPath, catalogueStatePath(deps.config.dataPath)));
      const path = confinedPath(root, output);

      if (overlaps(path, state) || overlaps(state, path)) {
        throw new Error("OPDS cleanup overlaps engine state");
      }

      let current = root;

      const components = relative(root, dirname(path)).split(sep).filter(Boolean);

      for (const component of components) {
        current = join(current, component);
        const info = await lstat(current);

        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error("OPDS cleanup ancestor is not an owned directory");
        }
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
