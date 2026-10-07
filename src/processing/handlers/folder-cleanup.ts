import { ok, err, type Result } from "neverthrow";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";
import * as v from "valibot";

export const folderCleanup = async (event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> => {
  if (event._tag !== "FolderDeleted") return ok([]);

  const { parent, name } = event;
  const folderPath = join(parent, name);
  const relativePath = relative(deps.config.filesPath, folderPath);
  const folderDataDir = join(deps.config.dataPath, relativePath);

  // A delete event can be stale: the source may have come back since it was queued.
  if (await deps.fs.exists(folderPath)) {
    deps.logger.debug("FolderCleanup", "Source exists, skipping stale delete", { path: relativePath });

    return ok([]);
  }

  deps.logger.info("FolderCleanup", "Removing", { path: relativePath });

  try {
    await deps.fs.rm(folderDataDir, { recursive: true });
  } catch (error) {
    if (v.is(v.object({ code: v.literal("ENOENT") }), error)) {
      deps.logger.debug("FolderCleanup", "Already removed", { path: relativePath });
    } else {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  deps.logger.info("FolderCleanup", "Done", { path: relativePath });

  if (relativePath === "") return ok([]);

  return ok([{ _tag: "FolderMetaSyncRequested", path: dirname(folderDataDir) }] as const);
};
