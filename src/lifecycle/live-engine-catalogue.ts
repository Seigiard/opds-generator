import { openLiveSynchronization, startLiveSynchronization, type LiveOptions } from "@seigiard/sync-engine";
import { Effect } from "effect";
import { join } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { FEED_FILE, INDEX_FILE } from "../constants.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService } from "../effect-file-system.ts";
import { ownedPromise } from "../utils/owned-promise.ts";
import { CatalogueDeps } from "../processing/effect-handler.ts";
import type { EventType } from "../processing/types.ts";
import { engineOptions, type EngineCatalogueOptions } from "./initial-engine-catalogue.ts";

type LiveCatalogueOptions = EngineCatalogueOptions & { readonly reconcileIntervalMs?: number };

/**
 * The production declaration of the live session. The minimum is the root feed and root page: when both already
 * exist, a failed verification keeps serving them and is retried by the engine; without them it is fatal.
 */
function liveOptions(deps: HandlerDeps, options: LiveCatalogueOptions): LiveOptions<EventType, Error, CatalogueDeps | EffectFileSystem> {
  const existingFile = async (path: string): Promise<boolean> => {
    try {
      return !(await deps.fs.stat(path)).isDirectory();
    } catch {
      return false;
    }
  };

  return {
    ...engineOptions(deps, options),
    reconcileIntervalMs: options.reconcileIntervalMs ?? deps.config.reconcileInterval * 1000,
    recovery: {
      existing: ownedPromise(
        async () =>
          (
            await Promise.all([existingFile(join(deps.config.dataPath, FEED_FILE)), existingFile(join(deps.config.dataPath, INDEX_FILE))])
          ).every(Boolean),
        (cause) => new Error(String(cause)),
      ).pipe(Effect.orElseSucceed(() => false)),
    },
  };
}

const provideServices =
  (deps: HandlerDeps) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CatalogueDeps, deps),
      Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
    );

/** The handle returns at once, so admission works while the first pass runs. The caller keeps the Effect scope open. */
export function startLiveEngineCatalogue(deps: HandlerDeps, options: LiveCatalogueOptions = {}) {
  return startLiveSynchronization(liveOptions(deps, options)).pipe(provideServices(deps));
}

/** Resolves after the first pass finished, or failed while the root minimum already served. */
export function openLiveEngineCatalogue(deps: HandlerDeps, options: LiveCatalogueOptions = {}) {
  return openLiveSynchronization(liveOptions(deps, options)).pipe(provideServices(deps));
}
