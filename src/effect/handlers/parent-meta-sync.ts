import { ok, type Result } from "neverthrow";
import { dirname, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";

export const parentMetaSync = async (event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> => {
  if (event._tag !== "EntryXmlChanged") return ok([]);

  const folderDataDir = event.parent;
  const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
  const parentDataDir = dirname(normalizedDir);
  const parentRelativePath = relative(deps.config.dataPath, parentDataDir);

  if (parentDataDir === deps.config.dataPath || parentRelativePath === ".") {
    deps.logger.info("ParentMetaSync", "Triggering root sync", { path: "/" });
    return ok([{ _tag: "FolderMetaSyncRequested", path: deps.config.dataPath }] as const);
  }

  deps.logger.info("ParentMetaSync", "Triggering parent sync", { path: parentRelativePath });
  return ok([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const);
};
