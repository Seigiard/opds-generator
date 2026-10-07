import { ok, err, type Result } from "neverthrow";
import { dirname, join, relative, basename } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { encodeUrlPath, normalizeFilenameTitle } from "../../utils/processor.ts";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";

export const folderSync = async (event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> => {
  if (event._tag !== "FolderCreated") return ok([]);

  const { parent, name } = event;
  const folderPath = join(parent, name);
  const relativePath = relative(deps.config.filesPath, folderPath);
  const folderDataDir = join(deps.config.dataPath, relativePath);

  deps.logger.info("FolderSync", "Processing", { path: relativePath || "(root)" });

  try {
    await deps.fs.mkdir(folderDataDir, { recursive: true });

    if (relativePath === "") {
      deps.logger.info("FolderSync", "Root folder - no _entry.xml needed");

      return ok([{ _tag: "FolderMetaSyncRequested", path: folderDataDir }] as const);
    }

    const folderName = normalizeFilenameTitle(basename(relativePath));
    const selfHref = `/${encodeUrlPath(relativePath)}/${FEED_FILE}`;

    const entry = new Entry(`urn:opds:catalog:${relativePath}`, folderName).addSubsection(selfHref, "navigation");

    const entryXml = entry.toXml({ prettyPrint: true });

    await deps.fs.atomicWrite(join(folderDataDir, FOLDER_ENTRY_FILE), entryXml);

    deps.logger.info("FolderSync", "Done", { path: relativePath });

    // folderMetaSync rewrites this _entry.xml unchanged for an empty folder and would not refresh the parent, so the parent that must list the new folder is refreshed here.
    return ok([
      { _tag: "FolderMetaSyncRequested", path: folderDataDir },
      { _tag: "FolderMetaSyncRequested", path: dirname(folderDataDir) },
    ] as const);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
};
