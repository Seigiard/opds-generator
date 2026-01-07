import { Effect } from "effect";
import { join, relative, basename } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { encodeUrlPath, normalizeFilenameTitle } from "../../utils/processor.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";

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

    yield* logger.info("FolderSync", "Processing", { path: relativePath || "(root)" });

    // Create data directory
    yield* fs.mkdir(folderDataDir, { recursive: true });

    // Create initial _entry.xml for non-root folders (count will be updated by folderMetaSync)
    if (relativePath !== "") {
      const folderName = normalizeFilenameTitle(basename(relativePath));
      const selfHref = `/${encodeUrlPath(relativePath)}/${FEED_FILE}`;

      const entry = new Entry(`urn:opds:catalog:${relativePath}`, folderName).addSubsection(selfHref, "navigation");

      const entryXml = entry.toXml({ prettyPrint: true });
      yield* fs.atomicWrite(join(folderDataDir, FOLDER_ENTRY_FILE), entryXml);

      yield* logger.info("FolderSync", "Done", { path: relativePath });
    } else {
      yield* logger.info("FolderSync", "Root folder - no _entry.xml needed");
    }

    return [{ _tag: "FolderMetaSyncRequested", path: folderDataDir }] as const;
  });
