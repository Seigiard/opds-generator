import type { Handlers } from "../../src/processing/catalogue-processor.ts";
import { fromPromiseHandler, type EffectHandler, type EffectHandlers } from "../../src/processing/effect-handler.ts";
import { bookCleanup } from "../../src/processing/handlers/book-cleanup.ts";
import { bookCleanupEffect } from "../../src/processing/handlers/book-cleanup-effect.ts";
import { bookSync } from "../../src/processing/handlers/book-sync.ts";
import { bookSyncEffect } from "../../src/processing/handlers/book-sync-effect.ts";
import { folderCleanup } from "../../src/processing/handlers/folder-cleanup.ts";
import { folderCleanupEffect } from "../../src/processing/handlers/folder-cleanup-effect.ts";
import { folderSync } from "../../src/processing/handlers/folder-sync.ts";
import { folderSyncEffect } from "../../src/processing/handlers/folder-sync-effect.ts";
import { folderMetaSync } from "../../src/processing/handlers/folder-meta-sync.ts";
import { folderMetaSyncEffect } from "../../src/processing/handlers/folder-meta-sync-effect.ts";
import type { EventType } from "../../src/processing/types.ts";

/** Issue #25/#35/#36: the Effect registry for a plain one. Ported handlers become their Effect variants; others are lifted. */
export function toEffectHandlers(handlers: Handlers): EffectHandlers {
  const effectHandlers: Partial<Record<EventType["_tag"], EffectHandler>> = {};

  for (const [tag, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    // SAFETY: Object.entries widens the keys of a Record<EventType["_tag"], …> to string.
    effectHandlers[tag as EventType["_tag"]] = effectVariant(handler);
  }

  return effectHandlers;
}

function effectVariant(handler: NonNullable<Handlers[EventType["_tag"]]>): EffectHandler {
  if (handler === bookSync) return bookSyncEffect;

  if (handler === bookCleanup) return bookCleanupEffect;

  if (handler === folderCleanup) return folderCleanupEffect;

  if (handler === folderSync) return folderSyncEffect;

  if (handler === folderMetaSync) return folderMetaSyncEffect;

  return fromPromiseHandler(handler);
}
