import { nativeSourceFileSystem, observeSourcePath, readSourceDirectory, removeAssociatedOutputs } from "@seigiard/sync-engine";
import { Effect, Predicate } from "effect";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { CatalogueEvent, type EffectHandler } from "../processing/effect-handler.ts";
import type { EventType } from "../processing/types.ts";
import { catalogueStatePath, includeCatalogueSource } from "./engine-policy.ts";

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
      const removed = yield* removeAssociatedOutputs(
        { sourcePath: filesPath, outputPath: dataPath, statePath: catalogueStatePath(dataPath), sourceRelativePath: path, outputs: [path] },
        sourceFs,
      );

      return removed ? [CatalogueEvent.FolderMetaSyncRequested({ path: dirname(join(dataPath, path)) })] : [];
    }

    if (deleted) return [];

    if (observation.entry.kind === "directory") yield* readSourceDirectory(filesPath, path, sourceFs);

    if (!handler) return yield* Effect.fail(new Error(`Unsupported engine work: ${event._tag}`));

    return yield* handler(event);
  }).pipe(Effect.uninterruptible);
}
