import { runInitialPass, type SourceEntry } from "@seigiard/sync-engine";
import { Effect } from "effect";
import { dirname, basename, join, extname } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService } from "../effect-file-system.ts";
import { BOOK_EXTENSIONS } from "../types.ts";
import { CatalogueDeps, CatalogueEvent, type EffectHandlers } from "../processing/effect-handler.ts";
import { bookSyncEffect } from "../processing/handlers/book-sync-effect.ts";
import { folderMetaSyncEffect } from "../processing/handlers/folder-meta-sync-effect.ts";
import type { EventType } from "../processing/types.ts";
import type { CatalogueScanner } from "./lifecycle.ts";

/** Temporary selection at createLifecycle's scanner seam; only an initial pass is supported. */
export function createInitialEngineScanner(deps: HandlerDeps): CatalogueScanner {
  return {
    async scan(request, signal) {
      if (request.kind !== "initial") throw new Error("The engine slice supports only the initial pass");
      // The engine takes the output lease itself and finishes its declared work before this scan returns.
      await Effect.runPromise(initialEngineCatalogue(deps), { signal });

      return [];
    },
  };
}

/** Explicit initial-pass selection seam. Production keeps its legacy lifecycle. */
export function initialEngineCatalogue(deps: HandlerDeps) {
  const handlers: EffectHandlers = {
    BookCreated: bookSyncEffect,
    FolderMetaSyncRequested: folderMetaSyncEffect,
  };

  const declare = (entries: readonly SourceEntry[]) =>
    Effect.succeed({
      work: entries.flatMap((entry) => {
        if (entry.kind !== "file" || !BOOK_EXTENSIONS.includes(extname(entry.path).slice(1).toLowerCase())) return [];
        const path = join(deps.config.filesPath, entry.path);

        return [CatalogueEvent.BookCreated({ parent: dirname(path), name: basename(path) })];
      }),
      publish: folderMetaSyncEffect(CatalogueEvent.FolderMetaSyncRequested({ path: deps.config.dataPath })).pipe(
        Effect.uninterruptible,
        Effect.asVoid,
      ),
    });

  return runInitialPass<EventType, Error, CatalogueDeps | EffectFileSystem>({
    sourcePath: deps.config.filesPath,
    outputPath: deps.config.dataPath,
    declare,
    handle: (event) => {
      const handler = handlers[event._tag];

      return handler ? handler(event).pipe(Effect.uninterruptible) : Effect.fail(new Error(`Unsupported initial work: ${event._tag}`));
    },
  }).pipe(Effect.provideService(CatalogueDeps, deps), Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)));
}
