import { Effect } from "effect";
import { join, relative, basename } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { encodeUrlPath, normalizeFilenameTitle } from "../../utils/processor.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";
import { log } from "../../logging/index.ts";

export const folderSync = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> => {
  if (event._tag !== "FolderCreated") return Effect.succeed([]);

  return Effect.flatMap(ConfigService, (config) =>
    Effect.flatMap(FileSystemService, (fs) => {
      const { parent, name } = event;
      const folderPath = join(parent, name);
      const relativePath = relative(config.filesPath, folderPath);
      const folderDataDir = join(config.dataPath, relativePath);

      log.info("FolderSync", "Processing", { path: relativePath || "(root)" });

      const createDir = fs.mkdir(folderDataDir, { recursive: true });

      if (relativePath === "") {
        return Effect.flatMap(createDir, () => {
          log.info("FolderSync", "Root folder - no _entry.xml needed");
          return Effect.succeed([{ _tag: "FolderMetaSyncRequested", path: folderDataDir }] as const);
        });
      }

      const folderName = normalizeFilenameTitle(basename(relativePath));
      const selfHref = `/${encodeUrlPath(relativePath)}/${FEED_FILE}`;
      const entry = new Entry(`urn:opds:catalog:${relativePath}`, folderName).addSubsection(selfHref, "navigation");
      const entryXml = entry.toXml({ prettyPrint: true });

      return createDir.pipe(
        Effect.flatMap(() => fs.atomicWrite(join(folderDataDir, FOLDER_ENTRY_FILE), entryXml)),
        Effect.map(() => {
          log.info("FolderSync", "Done", { path: relativePath });
          return [{ _tag: "FolderMetaSyncRequested", path: folderDataDir }] as const;
        }),
      );
    }),
  );
};
