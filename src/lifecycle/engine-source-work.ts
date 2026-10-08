import { nativeSourceFileSystem, observeSourcePath, readSourceDirectory } from "@seigiard/sync-engine";
import { Effect, Predicate } from "effect";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { CatalogueEvent, type EffectHandler } from "../processing/effect-handler.ts";
import type { EventType } from "../processing/types.ts";
import { includeCatalogueSource } from "./engine-policy.ts";

/** Source authority and output association for OPDS. Extraction and rendering stay in handlers. */
export function engineSourceWork(deps: HandlerDeps, event: EventType, handler: EffectHandler | undefined) {
  return Effect.gen(function* () {
    if (Predicate.isTagged(event, "Ignored")) return [];
    const { filesPath, dataPath } = deps.config;

    const path = Predicate.isTagged(event, "FolderMetaSyncRequested")
      ? relative(dataPath, event.path)
      : relative(filesPath, join(event.parent, event.name));

    if (!includeCatalogueSource(path)) return [];

    const sourceFs = { ...nativeSourceFileSystem, readdir: (source: string) => deps.fs.readdir(source) };
    const observation = yield* observeSourcePath(filesPath, path, sourceFs);
    const deleted = Predicate.isTagged(event, "BookDeleted") || Predicate.isTagged(event, "FolderDeleted");

    if (observation.state === "absent") {
      const removed = yield* removeOutputPath(deps, join(dataPath, path));

      return removed ? [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(join(dataPath, path)) })] : [];
    }

    if (deleted) {
      const obsoleteBook = Predicate.isTagged(event, "BookDeleted") && observation.entry.kind === "directory";
      const obsoleteFolder = Predicate.isTagged(event, "FolderDeleted") && observation.entry.kind === "file";

      if (!obsoleteBook && !obsoleteFolder) return [];

      const removed = yield* removeOutputPath(deps, join(dataPath, path));

      return removed ? [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(join(dataPath, path)) })] : [];
    }

    if (observation.entry.kind === "directory") yield* readSourceDirectory(filesPath, path, sourceFs);

    if (!handler) {
      throw new Error(`Unsupported engine work: ${event._tag}`);
    }

    const cascades = yield* handler(event);

    return cascades;
  }).pipe(Effect.uninterruptible);
}

function removeOutputPath(deps: HandlerDeps, output: string): Effect.Effect<boolean, Error> {
  return Effect.tryPromise({
    try: async () => {
      const existed = await deps.fs.exists(output);

      if (existed) await deps.fs.rm(output, { recursive: true });

      return existed;
    },
    catch: (cause) => new Error(String(cause)),
  }).pipe(Effect.uninterruptible);
}
