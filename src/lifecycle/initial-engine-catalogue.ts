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
import type { EventType } from "../processing/types.ts";
import { orphanedOutputs } from "./orphans.ts";
import { engineSourceWork } from "./engine-source-work.ts";
import { withHandlerLogs } from "./handler-logging.ts";
import { catalogueStatePath, includeCatalogueSource } from "./engine-policy.ts";
import { PROCESSING_VERSIONS } from "../processing-versions.ts";

/** Initial-pass composition for contract tests; production runs the live composition. */
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

      const books = entries.flatMap((entry) => {
        if (entry.kind !== "file" || !BOOK_EXTENSIONS.includes(extname(entry.path).slice(1).toLowerCase())) return [];
        const path = join(deps.config.filesPath, entry.path);

        return [CatalogueEvent.BookCreated({ parent: dirname(path), name: basename(path) })];
      });

      const root = CatalogueEvent.FolderMetaSyncRequested({ path: deps.config.dataPath });
      const removed = yield* orphanedOutputs(deps, entries);

      return {
        // The root feed and page are the minimum a deployment is usable with. Book entries join it as work completes.
        minimum: [root],
        work: [
          ...removed,
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
            processingVersion: options.processingVersions?.book ?? PROCESSING_VERSIONS.book,
            outputPaths: [join(source, "entry.xml"), join(source, event.name)],
          };
        }

        if (Predicate.isTagged(event, "FolderMetaSyncRequested")) {
          const source = relative(deps.config.dataPath, event.path);

          if (!includeCatalogueSource(source)) return undefined;

          return {
            sourcePaths: [source],
            resultKind: "folder",
            processingVersion: options.processingVersions?.folder ?? PROCESSING_VERSIONS.folder,
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
    handle: (event) => withHandlerLogs(deps, event, engineSourceWork(deps, event, handlers[event._tag])),
  };
}
