import type { Handlers } from "../../src/processing/catalogue-processor.ts";
import { fromPromiseHandler, type EffectHandler, type EffectHandlers } from "../../src/processing/effect-handler.ts";
import { bookSync } from "../../src/processing/handlers/book-sync.ts";
import { bookSyncEffect } from "../../src/processing/handlers/book-sync-effect.ts";
import { folderSync } from "../../src/processing/handlers/folder-sync.ts";
import { folderSyncEffect } from "../../src/processing/handlers/folder-sync-effect.ts";
import { folderMetaSync } from "../../src/processing/handlers/folder-meta-sync.ts";
import { folderMetaSyncEffect } from "../../src/processing/handlers/folder-meta-sync-effect.ts";
import type { EventType } from "../../src/processing/types.ts";

/** Issue #25: the Effect registry for a plain one. The real `bookSync` becomes its Effect port; other handlers are lifted. */
export function toEffectHandlers(handlers: Handlers): EffectHandlers {
  const effectHandlers: Partial<Record<EventType["_tag"], EffectHandler>> = {};

  for (const [tag, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    // SAFETY: Object.entries widens the keys of a Record<EventType["_tag"], …> to string.
    effectHandlers[tag as EventType["_tag"]] =
      handler === bookSync
        ? bookSyncEffect
        : handler === folderSync
          ? folderSyncEffect
          : handler === folderMetaSync
            ? folderMetaSyncEffect
            : fromPromiseHandler(handler);
  }

  return effectHandlers;
}
