import { openSynchronization, runInitialPass, type InitialPass, type SourceEntry } from "@seigiard/sync-engine";
import { Effect, Predicate } from "effect";
import { dirname, basename, join, extname } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService } from "../effect-file-system.ts";
import { BOOK_EXTENSIONS } from "../types.ts";
import { CatalogueDeps, CatalogueEvent, type EffectHandlers } from "../processing/effect-handler.ts";
import { bookSyncEffect } from "../processing/handlers/book-sync-effect.ts";
import { folderMetaSyncEffect } from "../processing/handlers/folder-meta-sync-effect.ts";
import { folderSyncEffect } from "../processing/handlers/folder-sync-effect.ts";
import { ownedPromise } from "../utils/owned-promise.ts";
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
  return runInitialPass(engineOptions(deps)).pipe(
    Effect.provideService(CatalogueDeps, deps),
    Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
  );
}

/** The caller's Effect scope owns the initial publication, later work and output lease. */
export function openEngineCatalogue(deps: HandlerDeps) {
  return openSynchronization(engineOptions(deps)).pipe(
    Effect.provideService(CatalogueDeps, deps),
    Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
  );
}

export function engineOptions(deps: HandlerDeps): InitialPass<EventType, Error, CatalogueDeps | EffectFileSystem> {
  const handlers: EffectHandlers = {
    BookCreated: bookSyncEffect,
    FolderCreated: folderSyncEffect,
    FolderMetaSyncRequested: folderMetaSyncEffect,
  };

  const declare = (entries: readonly SourceEntry[]) =>
    Effect.gen(function* () {
      const folders = entries
        .filter((entry) => entry.kind === "directory")
        .sort((a, b) => b.path.split("/").length - a.path.split("/").length);

      for (const folder of folders) {
        yield* ownedPromise(
          () => deps.fs.mkdir(join(deps.config.dataPath, folder.path), { recursive: true }),
          (cause) => new Error(String(cause)),
        );
      }

      const books = entries.flatMap((entry) => {
        if (entry.kind !== "file" || !BOOK_EXTENSIONS.includes(extname(entry.path).slice(1).toLowerCase())) return [];
        const path = join(deps.config.filesPath, entry.path);

        return [CatalogueEvent.BookCreated({ parent: dirname(path), name: basename(path) })];
      });

      return {
        work: [
          ...books,
          ...folders.map((folder) => CatalogueEvent.FolderMetaSyncRequested({ path: join(deps.config.dataPath, folder.path) })),
        ],
        publish: folderMetaSyncEffect(CatalogueEvent.FolderMetaSyncRequested({ path: deps.config.dataPath })).pipe(
          Effect.uninterruptible,
          Effect.asVoid,
        ),
      };
    });

  return {
    sourcePath: deps.config.filesPath,
    outputPath: deps.config.dataPath,
    declare,
    key: (event) => (Predicate.isTagged(event, "FolderMetaSyncRequested") ? `${event._tag}:${event.path}` : undefined),
    handle: (event) => {
      const handler = handlers[event._tag];

      return handler ? handler(event).pipe(Effect.uninterruptible) : Effect.fail(new Error(`Unsupported engine work: ${event._tag}`));
    },
  };
}
