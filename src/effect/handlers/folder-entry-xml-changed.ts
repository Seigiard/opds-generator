import { ok, type Result } from "neverthrow";
import { dirname, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";

export const folderEntryXmlChanged = async (event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> => {
  if (event._tag !== "FolderEntryXmlChanged") return ok([]);

  const folderDataDir = event.parent;
  const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
  const parentDataDir = dirname(normalizedDir);
  const parentRelativePath = relative(deps.config.dataPath, parentDataDir);

  deps.logger.info("FolderEntryXmlChanged", "Triggering folder-meta-sync for parent");

  if (parentDataDir === deps.config.dataPath || parentRelativePath === ".") {
    return ok([{ _tag: "FolderMetaSyncRequested", path: deps.config.dataPath }] as const);
  } else {
    return ok([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const);
  }
};
