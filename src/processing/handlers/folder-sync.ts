import { ok, err, type Result } from "neverthrow";
import { dirname, join, relative, basename } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { encodeUrlPath, normalizeFilenameTitle } from "../../utils/processor.ts";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";
import { ENTRY_FILE, FEED_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";
import { BOOK_EXTENSIONS } from "../../types.ts";

/** inotifywait adds its watch to a new folder only after the create event, so anything copied in meanwhile raises no event; list the folder to catch it. */
async function discoverContents(folderPath: string, folderDataDir: string, deps: HandlerDeps): Promise<EventType[]> {
  const found: EventType[] = [];

  for (const name of await deps.fs.readdir(folderPath)) {
    if (name.startsWith(".")) continue;
    deps.signal?.throwIfAborted();

    const childPath = join(folderPath, name);
    const isDirectory = (await deps.fs.stat(childPath)).isDirectory();

    if (isDirectory) {
      found.push({ _tag: "FolderCreated", parent: folderPath, name });
      continue;
    }

    const ext = name.split(".").pop()?.toLowerCase() ?? "";

    // A book that got its own event is already processed or queued; skip it instead of extracting twice.
    if (BOOK_EXTENSIONS.includes(ext) && !(await deps.fs.exists(join(folderDataDir, name, ENTRY_FILE)))) {
      found.push({ _tag: "BookCreated", parent: folderPath, name });
    }
  }

  return found;
}

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
      ...(await discoverContents(folderPath, folderDataDir, deps)),
    ]);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
};
