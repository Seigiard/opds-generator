import { Predicate } from "effect";
import { join, relative } from "node:path";
import type { HandlerDeps } from "../context.ts";
import type { EventType } from "../processing/types.ts";

export const failureKey = (deps: HandlerDeps) => (event: EventType) => {
  if (Predicate.isTagged(event, "FolderMetaSyncRequested")) return `folder:${event.path}`;

  if (Predicate.isTagged(event, "FolderDeleted")) {
    return `folder:${join(deps.config.dataPath, relative(deps.config.filesPath, join(event.parent, event.name)))}`;
  }

  if (Predicate.isTagged(event, "Ignored")) return undefined;

  return `source:${join(event.parent, event.name)}`;
};
