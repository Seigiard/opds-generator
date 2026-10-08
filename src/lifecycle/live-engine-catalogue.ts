import { openLiveSynchronization } from "@seigiard/sync-engine";
import { Effect, Predicate } from "effect";
import { join, relative } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService } from "../effect-file-system.ts";
import { CatalogueDeps } from "../processing/effect-handler.ts";
import { ownedPromise } from "../utils/owned-promise.ts";
import { engineOptions } from "./initial-engine-catalogue.ts";

/** Explicit live selection. The caller keeps the Effect scope open for the session. */
export function openLiveEngineCatalogue(deps: HandlerDeps, options: { readonly reconcileIntervalMs?: number } = {}) {
  const initial = engineOptions(deps);

  return openLiveSynchronization({
    ...initial,
    reconcileIntervalMs: options.reconcileIntervalMs ?? deps.config.reconcileInterval * 1000,
    declare: (entries, request) =>
      Effect.gen(function* () {
        const plan = yield* initial.declare(entries);
        const work = [];

        for (const event of plan.work) {
          if (!Predicate.isTagged(event, "BookCreated") || request.kind === "initial" || request.force) {
            work.push(event);
            continue;
          }

          const path = relative(deps.config.filesPath, join(event.parent, event.name));
          const dirty = request.changedPaths.some((changed) => changed === path || path.startsWith(`${changed}/`));

          const exists = yield* ownedPromise(
            () => Bun.file(join(deps.config.dataPath, path, "entry.xml")).exists(),
            (cause) => new Error(String(cause)),
          );

          if (dirty || !exists) work.push(event);
        }

        return { ...plan, work };
      }),
  }).pipe(Effect.provideService(CatalogueDeps, deps), Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)));
}
