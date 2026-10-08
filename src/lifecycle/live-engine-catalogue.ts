import { openLiveSynchronization } from "@seigiard/sync-engine";
import { Effect } from "effect";
import type { HandlerDeps } from "../context.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService } from "../effect-file-system.ts";
import { CatalogueDeps } from "../processing/effect-handler.ts";
import { engineOptions, type EngineCatalogueOptions } from "./initial-engine-catalogue.ts";

/** Explicit live selection. The caller keeps the Effect scope open for the session. */
export function openLiveEngineCatalogue(
  deps: HandlerDeps,
  options: EngineCatalogueOptions & { readonly reconcileIntervalMs?: number } = {},
) {
  const initial = engineOptions(deps, options);

  return openLiveSynchronization({
    ...initial,
    reconcileIntervalMs: options.reconcileIntervalMs ?? deps.config.reconcileInterval * 1000,
  }).pipe(Effect.provideService(CatalogueDeps, deps), Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)));
}
