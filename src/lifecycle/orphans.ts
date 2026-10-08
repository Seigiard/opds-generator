import { Effect } from "effect";
import { basename, dirname, extname, join } from "node:path";
import type { SourceEntry } from "@seigiard/sync-engine";
import type { HandlerDeps } from "../context.ts";
import { ENTRY_FILE, FOLDER_ENTRY_FILE } from "../constants.ts";
import { CatalogueEvent } from "../processing/effect-handler.ts";
import type { EventType } from "../processing/types.ts";
import { BOOK_EXTENSIONS } from "../types.ts";
import { ownedPromise } from "../utils/owned-promise.ts";

/**
 * Output entries whose source is no longer in the scan: a book folder (`entry.xml`) or a catalogue folder
 * (`_entry.xml`) in DATA. They are candidates only. The engine's source work re-observes each path and removes it
 * on confirmed absence; an unreadable source never authorizes removal. Dot names are bookkeeping.
 */
export function orphanedOutputs(deps: HandlerDeps, entries: readonly SourceEntry[]): Effect.Effect<readonly EventType[]> {
  const books = new Set<string>();
  const folders = new Set<string>();

  for (const entry of entries) {
    if (entry.kind === "directory") folders.add(entry.path);
    else if (BOOK_EXTENSIONS.includes(extname(entry.path).slice(1).toLowerCase())) books.add(entry.path);
  }

  const scan = ownedPromise(
    async () => {
      const orphans: EventType[] = [];

      const walk = async (path: string): Promise<void> => {
        let names: string[];

        try {
          names = await deps.fs.readdir(join(deps.config.dataPath, path));
        } catch {
          // A directory that cannot be read yields no candidates; absence is never inferred from a failed read.
          return;
        }

        for (const name of names.sort()) {
          if (name.startsWith(".")) continue;
          const relative = path === "" ? name : join(path, name);
          const absolute = join(deps.config.dataPath, relative);

          try {
            if (!(await deps.fs.stat(absolute)).isDirectory()) continue;

            if (await deps.fs.exists(join(absolute, ENTRY_FILE))) {
              if (!books.has(relative)) {
                orphans.push(
                  CatalogueEvent.BookDeleted({ parent: dirname(join(deps.config.filesPath, relative)), name: basename(relative) }),
                );
              }

              continue;
            }

            if (await deps.fs.exists(join(absolute, FOLDER_ENTRY_FILE))) {
              if (!folders.has(relative)) {
                orphans.push(
                  CatalogueEvent.FolderDeleted({ parent: dirname(join(deps.config.filesPath, relative)), name: basename(relative) }),
                );

                continue;
              }
            }

            await walk(relative);
          } catch {
            // A failed read of one entry skips it; the next pass looks again.
          }
        }
      };

      await walk("");

      return orphans;
    },
    (cause) => new Error(String(cause)),
  );

  return scan.pipe(Effect.orElseSucceed((): readonly EventType[] => []));
}
