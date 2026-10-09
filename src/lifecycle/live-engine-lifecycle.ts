import type { LiveHandle, LiveStatus, PassAdmission } from "@seigiard/sync-engine";
import { Cause, Effect, Predicate } from "effect";
import { relative, join } from "node:path";
import type { HandlerDeps } from "../context.ts";
import type { EventType } from "../processing/types.ts";
import { startLiveEngineCatalogue } from "./live-engine-catalogue.ts";
import type { EngineCatalogueOptions } from "./initial-engine-catalogue.ts";

const firstLine = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split("\n")[0] ?? "";

type Session = LiveHandle<EventType, unknown>;

const STOPPED: LiveStatus<EventType> = {
  state: "stopped",
  pass: null,
  followUp: null,
  failure: null,
  availability: null,
  work: { state: "stopped", pending: 0, active: null, errors: [] },
};

/**
 * Promise-facing transport adapter for the Effect-owned session. The engine owns scans, pass coalescing, the
 * periodic timer, the retry of a failed first pass and admission while that pass runs; this adapter only
 * translates HTTP input and the process lifetime.
 *
 * A failed first pass is fatal only while no usable root feed and page exist. With usable output the process
 * stays up, serves it, reports the failure in `status()` and the engine retries on a request or reconcile tick.
 */
export function createLiveEngineLifecycle(
  deps: HandlerDeps,
  options: EngineCatalogueOptions & { readonly onFatal?: (cause: unknown) => void; readonly reconcileIntervalMs?: number } = {},
) {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const handle = Promise.withResolvers<Session>();
  let running: Promise<void> | undefined;
  // A stop that precedes the session leaves nobody to read this rejection.
  handle.promise.catch(() => undefined);

  const run = () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* startLiveEngineCatalogue(deps, options);
          handle.resolve(session);
          yield* session.ready;
          started.resolve();
          yield* Effect.never;
        }),
      ),
      { signal: controller.signal },
    ).catch((cause: unknown) => {
      handle.reject(cause);
      started.reject(cause);

      if (!controller.signal.aborted) options.onFatal?.(cause);
    });

  const admit = async <A>(use: (session: Session) => Effect.Effect<A>, otherwise: A): Promise<A> => {
    if (controller.signal.aborted) return otherwise;
    const session = await handle.promise.catch(() => undefined);

    return session ? Effect.runPromise(use(session)) : otherwise;
  };

  return {
    start() {
      running ??= run();

      return started.promise;
    },
    accepting: () => running !== undefined && !controller.signal.aborted,
    async submit(event: EventType) {
      if (Predicate.isTagged(event, "Ignored") || Predicate.isTagged(event, "FolderMetaSyncRequested")) return;
      const path = relative(deps.config.filesPath, join(event.parent, event.name));

      await admit<PassAdmission>((session) => session.notify([path]), "rejected");
    },
    requestScan: (request: { readonly kind: "resync"; readonly force: boolean }) =>
      admit<PassAdmission>((session) => session.requestPass({ force: request.force }), "rejected"),
    async status() {
      const session = await handle.promise.catch(() => undefined);
      const { availability, ...engine } = session ? await Effect.runPromise(session.status) : STOPPED;
      const settled = engine.state === "complete" || engine.state === "complete-with-errors";
      const verifying = engine.state === "working" || engine.pass !== null;

      const errors = [
        ...engine.work.errors.map((error) => ({ source: "work" as const, message: firstLine(error.cause) })),
        ...(engine.failure ? [{ source: "pass" as const, message: firstLine(engine.failure) }] : []),
      ];

      return {
        ...engine,
        available: availability !== null,
        availableFrom: availability,
        verifying,
        completed: settled && !verifying,
        errors,
      };
    },
    async stop() {
      controller.abort();
      await running;
    },
  };
}
