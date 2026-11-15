import {
  nativeSourceFileSystem,
  observeSourcePath,
  readSourceDirectory,
  removeAssociatedOutputs,
  type OutputCleanup,
} from "@seigiard/sync-engine";
import { Effect, Predicate } from "effect";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { CatalogueEvent, type EffectHandler } from "../processing/effect-handler.ts";
import type { EventType } from "../processing/types.ts";
import { catalogueStatePath, includeCatalogueSource } from "./engine-policy.ts";

export function engineSourceWork(
  deps: HandlerDeps,
  event: EventType,
  handler: EffectHandler | undefined,
  cleanup: OutputCleanup | undefined,
) {
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
        if (deleted && error.reason === "unsupported-path") {
          unsupportedSourceReplacement = true;

          return Effect.succeed({ state: "absent" } as const);
        }

        return Effect.fail(error);
      }),
    );

    if (observation.state === "absent") {
      const removed = unsupportedSourceReplacement
        ? yield* removeObsoleteOutput(cleanup, path)
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

      if (deleted) {
        const parent = dirname(path);
        const refreshableParent = parent === "." || (yield* isDirectorySourcePath(filesPath, parent, sourceFs));

        if (!refreshableParent) return [];
      }

      return removed ? [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(join(dataPath, path)) })] : [];
    }

    if (deleted) {
      const obsoleteBook = Predicate.isTagged(event, "BookDeleted") && observation.entry.kind === "directory";
      const obsoleteFolder = Predicate.isTagged(event, "FolderDeleted") && observation.entry.kind === "file";

      if (!obsoleteBook && !obsoleteFolder) return [];

      const removed = yield* removeObsoleteOutput(cleanup, path);

      return removed ? [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(join(dataPath, path)) })] : [];
    }

    if (observation.entry.kind === "directory") yield* readSourceDirectory(filesPath, path, sourceFs);

    if (!handler) {
      return yield* Effect.fail(new Error(`Unsupported engine work: ${event._tag}`));
    }

    return yield* handler(event);
  }).pipe(Effect.uninterruptible);
}

function isDirectorySourcePath(sourcePath: string, path: string, sourceFs: typeof nativeSourceFileSystem): Effect.Effect<boolean> {
  return observeSourcePath(sourcePath, path, sourceFs).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: (observation) => observation.state === "present" && observation.entry.kind === "directory",
    }),
  );
}

function removeObsoleteOutput(cleanup: OutputCleanup | undefined, path: string) {
  return cleanup ? cleanup([path]) : Effect.fail(new Error("Engine cleanup capability is unavailable"));
}
