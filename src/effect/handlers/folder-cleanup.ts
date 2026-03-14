import { ok, err, type Result } from "neverthrow";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";

export const folderCleanup = async (event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> => {
  if (event._tag !== "FolderDeleted") return ok([]);

  const { parent, name } = event;
  const folderPath = join(parent, name);
  const relativePath = relative(deps.config.filesPath, folderPath);
  const folderDataDir = join(deps.config.dataPath, relativePath);

  deps.logger.info("FolderCleanup", "Removing", { path: relativePath });

  try {
    await deps.fs.rm(folderDataDir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      deps.logger.debug("FolderCleanup", "Already removed", { path: relativePath });
    } else {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  deps.logger.info("FolderCleanup", "Done", { path: relativePath });
  const parentDataDir = dirname(folderDataDir);
  if (parentDataDir !== deps.config.dataPath && parentDataDir !== ".") {
    return ok([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const);
  }
  return ok([]);
};
