import { ok, err, type Result } from "neverthrow";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";
import * as v from "valibot";

export const bookCleanup = async (event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> => {
  if (event._tag !== "BookDeleted") return ok([]);

  const { parent, name } = event;
  const filePath = join(parent, name);
  const relativePath = relative(deps.config.filesPath, filePath);
  const bookDataDir = join(deps.config.dataPath, relativePath);

  // A delete event can be stale: the source may have come back since it was queued.
  if (await deps.fs.exists(filePath)) {
    deps.logger.debug("BookCleanup", "Source exists, skipping stale delete", { path: relativePath });

    return ok([]);
  }

  deps.logger.info("BookCleanup", "Removing", { path: relativePath });

  try {
    await deps.fs.rm(bookDataDir, { recursive: true });
  } catch (error) {
    if (v.is(v.object({ code: v.literal("ENOENT") }), error)) {
      deps.logger.debug("BookCleanup", "Already removed", { path: relativePath });
    } else {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  deps.logger.info("BookCleanup", "Done", { path: relativePath });
  const parentDataDir = dirname(bookDataDir);

  return ok([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const);
};
