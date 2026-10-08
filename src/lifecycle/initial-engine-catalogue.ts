import { openSynchronization, runInitialPass, type InitialPass, type SourceEntry } from "@seigiard/sync-engine";
import { Effect, Predicate } from "effect";
import { dirname, basename, join, extname, relative } from "node:path";
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
import { engineSourceWork } from "./engine-source-work.ts";
import { catalogueStatePath, includeCatalogueSource } from "./engine-policy.ts";

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
export function initialEngineCatalogue(deps: HandlerDeps, options: EngineCatalogueOptions = {}) {
  return runInitialPass(engineOptions(deps, options)).pipe(
    Effect.provideService(CatalogueDeps, deps),
    Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
  );
}

/** The caller's Effect scope owns the initial publication, later work and output lease. */
export function openEngineCatalogue(deps: HandlerDeps, options: EngineCatalogueOptions = {}) {
  return openSynchronization(engineOptions(deps, options)).pipe(
    Effect.provideService(CatalogueDeps, deps),
    Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
  );
}

export interface EngineCatalogueOptions {
  /** Runs once, after the root feed and browser page exist, before the remaining catalogue work. */
  readonly onMinimum?: Effect.Effect<void>;
  readonly check?: "metadata" | "content";
  readonly processingVersions?: { readonly book?: string; readonly folder?: string };
}

export function engineOptions(
  deps: HandlerDeps,
  options: EngineCatalogueOptions = {},
): InitialPass<EventType, Error, CatalogueDeps | EffectFileSystem> {
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

      const root = CatalogueEvent.FolderMetaSyncRequested({ path: deps.config.dataPath });

      return {
        // The root feed and page are the minimum a deployment is usable with. Book entries join it as work completes.
        minimum: [root],
        work: [
          ...books,
          ...folders.map((folder) => CatalogueEvent.FolderMetaSyncRequested({ path: join(deps.config.dataPath, folder.path) })),
          root,
        ],
        publish: Effect.void,
      };
    });

  return {
    sourcePath: deps.config.filesPath,
    outputPath: deps.config.dataPath,
    statePath: catalogueStatePath(deps.config.dataPath),
    includeSource: includeCatalogueSource,
    freshness: {
      check: options.check,
      describe: (event) => {
        if (Predicate.isTagged(event, "BookCreated")) {
          const source = relative(deps.config.filesPath, join(event.parent, event.name));

          if (!includeCatalogueSource(source)) return undefined;

          return {
            sourcePaths: [source],
            resultKind: "book",
            processingVersion: options.processingVersions?.book ?? "1",
            outputPaths: [join(source, "entry.xml"), join(source, event.name)],
          };
        }

        if (Predicate.isTagged(event, "FolderMetaSyncRequested")) {
          const source = relative(deps.config.dataPath, event.path);

          if (!includeCatalogueSource(source)) return undefined;

          return {
            sourcePaths: [source],
            resultKind: "folder",
            processingVersion: options.processingVersions?.folder ?? "1",
            outputPaths: [join(source, "feed.xml"), join(source, "index.html"), ...(source ? [join(source, "_entry.xml")] : [])],
          };
        }

        return undefined;
      },
    },
    declare,
    onMinimum: options.onMinimum,
    key: (event) => (Predicate.isTagged(event, "FolderMetaSyncRequested") ? `${event._tag}:${event.path}` : undefined),
    failureKey: (event) =>
      Predicate.isTagged(event, "FolderMetaSyncRequested")
        ? `folder:${event.path}`
        : Predicate.isTagged(event, "Ignored")
          ? undefined
          : `source:${join(event.parent, event.name)}`,
    handle: (event) => {
      const handler = handlers[event._tag];

      return engineSourceWork(deps, event, handler);
    },
  };
}
