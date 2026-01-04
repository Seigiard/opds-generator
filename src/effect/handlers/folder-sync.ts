import { Effect } from "effect";
import { join, relative, basename } from "node:path";
import { readdir } from "node:fs/promises";
import { Entry } from "opds-ts/v1.2";
import { BOOK_EXTENSIONS } from "../../types.ts";
import { encodeUrlPath, formatFolderDescription } from "../../utils/processor.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";

export const folderSync = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
  Effect.gen(function* () {
    if (event._tag !== "FolderCreated") return [];
    const { parent, name } = event;
    const config = yield* ConfigService;
    const logger = yield* LoggerService;
    const fs = yield* FileSystemService;

    const folderPath = join(parent, name);
    const relativePath = relative(config.filesPath, folderPath);
    const folderDataDir = join(config.dataPath, relativePath);

    yield* logger.info("FolderSync", `Processing: ${relativePath || "(root)"}`);

    // Create data directory
    yield* fs.mkdir(folderDataDir, { recursive: true });

    // Only create _entry.xml for non-root folders
    if (relativePath !== "") {
      const folderName = basename(relativePath);

      // Count contents
      const counts = yield* Effect.tryPromise({
        try: async () => {
          let subfolders = 0;
          let books = 0;
          try {
            const entries = await readdir(folderPath, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                subfolders++;
              } else if (entry.isFile()) {
                const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
                if (BOOK_EXTENSIONS.includes(ext)) {
                  books++;
                }
              }
            }
          } catch {
            // Folder might not exist yet
          }
          return { subfolders, books };
        },
        catch: (e) => e as Error,
      }).pipe(Effect.catchAll(() => Effect.succeed({ subfolders: 0, books: 0 })));

      // Build entry
      const entry = new Entry(`urn:opds:catalog:${relativePath}`, folderName).addSubsection(
        `/${encodeUrlPath(relativePath)}/feed.xml`,
        "navigation",
      );

      const description = formatFolderDescription(counts.subfolders, counts.books);
      if (description) {
        entry.setSummary(description);
      }

      const entryXml = entry.toXml({ prettyPrint: true });
      yield* fs.atomicWrite(join(folderDataDir, "_entry.xml"), entryXml);

      yield* logger.info("FolderSync", `Done: ${relativePath}`, counts);
    } else {
      yield* logger.info("FolderSync", "Root folder - no _entry.xml needed");
    }

    return [];
  });
