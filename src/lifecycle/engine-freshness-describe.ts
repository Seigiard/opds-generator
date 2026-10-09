import { Predicate } from "effect";
import { join, relative } from "node:path";
import type { HandlerDeps } from "../context.ts";
import { PROCESSING_VERSIONS } from "../processing-versions.ts";
import type { EventType } from "../processing/types.ts";
import { includeCatalogueSource } from "./engine-policy.ts";
import type { EngineCatalogueOptions } from "./initial-engine-catalogue.ts";

export const describeFreshness =
  (deps: HandlerDeps, options: EngineCatalogueOptions = {}) =>
  (event: EventType) => {
    if (Predicate.isTagged(event, "BookCreated")) {
      const source = relative(deps.config.filesPath, join(event.parent, event.name));

      if (!includeCatalogueSource(source)) return undefined;

      return {
        sourcePaths: [source],
        resultKind: "book" as const,
        processingVersion: options.processingVersions?.book ?? PROCESSING_VERSIONS.book,
        outputPaths: [join(source, "entry.xml"), join(source, event.name)],
      };
    }

    if (Predicate.isTagged(event, "FolderMetaSyncRequested")) {
      const source = relative(deps.config.dataPath, event.path);

      if (!includeCatalogueSource(source)) return undefined;

      return {
        sourcePaths: [source],
        resultKind: "folder" as const,
        processingVersion: options.processingVersions?.folder ?? PROCESSING_VERSIONS.folder,
        outputPaths: [join(source, "feed.xml"), join(source, "index.html"), ...(source ? [join(source, "_entry.xml")] : [])],
      };
    }

    return undefined;
  };
