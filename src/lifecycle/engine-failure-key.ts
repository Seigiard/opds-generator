import { Predicate } from "effect";
import { join, relative, resolve } from "node:path";
import type { HandlerDeps } from "../context.ts";
import type { EventType } from "../processing/types.ts";

export const folderFailureKey = (path: string) => `folder:${resolve(path)}`;

export const failureKey = (deps: HandlerDeps) => (event: EventType) => {
  if (Predicate.isTagged(event, "FolderMetaSyncRequested")) return folderFailureKey(event.path);

  if (Predicate.isTagged(event, "FolderDeleted")) {
    const source = join(event.parent, event.name);
    const output = join(deps.config.dataPath, relative(deps.config.filesPath, source));

    return folderFailureKey(output);
  }

  if (Predicate.isTagged(event, "Ignored")) return undefined;

  return `source:${join(event.parent, event.name)}`;
};
