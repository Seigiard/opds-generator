import type { LiveSynchronization } from "@seigiard/sync-engine";
import { Effect, Predicate } from "effect";
import { join, relative } from "node:path";
import type { HandlerDeps } from "../context.ts";
import type { EventType } from "../processing/types.ts";
import { openLiveEngineCatalogue } from "./live-engine-catalogue.ts";
import type { EngineCatalogueOptions } from "./initial-engine-catalogue.ts";

/** Promise-facing transport adapter; pass scheduling and the timer stay in the engine. */
export function createLiveEngineLifecycle(
  deps: HandlerDeps,
  options: EngineCatalogueOptions & { readonly onFatal?: (cause: unknown) => void; readonly reconcileIntervalMs?: number } = {},
) {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let session: LiveSynchronization<EventType, Error> | undefined;
  let running: Promise<void> | undefined;
  let followUp: { force: boolean } | undefined;
  const dirty = new Set<string>();

  return {
    start() {
      if (running) return started.promise;
      running = Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            session = yield* openLiveEngineCatalogue(deps, options);

            if (followUp) yield* session.requestPass(followUp);

            if (dirty.size > 0) yield* session.notify([...dirty]);
            followUp = undefined;
            dirty.clear();
            started.resolve();
            yield* Effect.never;
          }),
        ),
        { signal: controller.signal },
      ).catch((cause: unknown) => {
        started.reject(cause);

        if (!controller.signal.aborted) {
          options.onFatal?.(cause);
        }
      });

      return started.promise;
    },
    accepting: () => running !== undefined && !controller.signal.aborted,
    async submit(event: EventType) {
      if (controller.signal.aborted || Predicate.isTagged(event, "Ignored") || Predicate.isTagged(event, "FolderMetaSyncRequested")) return;
      const path = relative(deps.config.filesPath, join(event.parent, event.name));

      if (session) await Effect.runPromise(session.notify([path]));
      else dirty.add(path);
    },
    async requestScan(request: { readonly kind: "resync"; readonly force: boolean }): Promise<"started" | "queued" | "rejected"> {
      if (controller.signal.aborted) return "rejected";

      if (session) return Effect.runPromise(session.requestPass({ force: request.force }));
      followUp = { force: (followUp?.force ?? false) || request.force };

      return "queued";
    },
    status: () =>
      session
        ? Effect.runPromise(session.status)
        : { state: controller.signal.aborted ? "stopped" : "working", pass: controller.signal.aborted ? null : "initial" },
    async stop() {
      controller.abort();
      await running;
    },
  };
}
