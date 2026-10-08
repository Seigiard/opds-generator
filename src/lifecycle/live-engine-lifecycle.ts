import type { LiveSynchronization } from "@seigiard/sync-engine";
import { Cause, Effect, Predicate } from "effect";
import { join, relative } from "node:path";
import type { HandlerDeps } from "../context.ts";
import type { EventType } from "../processing/types.ts";
import { openLiveEngineCatalogue } from "./live-engine-catalogue.ts";
import type { EngineCatalogueOptions } from "./initial-engine-catalogue.ts";
import { FEED_FILE, INDEX_FILE } from "../constants.ts";

type Availability = "prior-output" | "minimum-publication";

const firstLine = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split("\n")[0] ?? "";

/**
 * Promise-facing transport adapter; pass scheduling and the periodic timer stay in the engine.
 *
 * A failed first pass is fatal only while no usable root feed and page exist. With usable output the process stays up,
 * serves it, reports the failure in `status()` and retries on a resync request or after the reconcile interval.
 */
export function createLiveEngineLifecycle(
  deps: HandlerDeps,
  options: EngineCatalogueOptions & { readonly onFatal?: (cause: unknown) => void; readonly reconcileIntervalMs?: number } = {},
) {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const retryDelayMs = options.reconcileIntervalMs ?? deps.config.reconcileInterval * 1000;
  let session: LiveSynchronization<EventType, Error> | undefined;
  let running: Promise<void> | undefined;
  let opening = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let availability: Availability | null = null;
  let startupFailure: Cause.Cause<unknown> | undefined;
  let priorOutput: Promise<void> = Promise.resolve();
  let followUp: { force: boolean } | undefined;
  const dirty = new Set<string>();

  const open = (): Promise<void> => {
    opening = true;

    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // The probe never rejects and finishes quickly, so waiting for it uninterruptibly is safe.
          yield* Effect.promise(() => priorOutput).pipe(Effect.uninterruptible);
          session = yield* openLiveEngineCatalogue(deps, {
            ...options,
            onMinimum: Effect.sync(() => {
              availability ??= "minimum-publication";
            }),
          });
          opening = false;
          startupFailure = undefined;

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
      opening = false;

      // A stop interrupts the open; that is shutdown, not a verification error.
      const failure = Cause.fail(cause);

      if (!controller.signal.aborted) startupFailure = failure;

      if (controller.signal.aborted || availability === null) {
        started.reject(cause);

        if (!controller.signal.aborted) options.onFatal?.(cause);

        return;
      }

      deps.logger.error("Lifecycle", "Initial verification failed; serving the existing catalogue", cause, {
        reason: firstLine(failure),
      });
      started.resolve();

      if (retryDelayMs > 0) retryTimer = setTimeout(retry, retryDelayMs);
    });
  };

  function retry() {
    clearTimeout(retryTimer);

    if (controller.signal.aborted || opening || session) return;
    running = open();
  }

  return {
    start() {
      if (running) return started.promise;
      // Existing root files are served by nginx independently of verification; record that before any work starts.
      priorOutput = Promise.all([
        deps.fs.exists(join(deps.config.dataPath, FEED_FILE)),
        deps.fs.exists(join(deps.config.dataPath, INDEX_FILE)),
      ]).then(
        ([feed, page]) => {
          if (feed && page) availability = "prior-output";
        },
        () => undefined,
      );
      running = open();

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

      if (startupFailure && !opening) {
        retry();

        return "started";
      }

      return "queued";
    },
    /**
     * Independent facts: `available` (a usable root feed and page are in DATA), `verifying` (a pass is active or pending),
     * `completed` (required work drained) and `errors` (retained failures). Engine fields stay as reported.
     */
    async status() {
      await priorOutput;
      const aborted = controller.signal.aborted;

      const engine = session
        ? await Effect.runPromise(session.status)
        : {
            state: aborted ? ("stopped" as const) : opening ? ("working" as const) : ("failed" as const),
            pass: opening && !aborted ? ("initial" as const) : null,
          };

      const settled = engine.state === "complete" || engine.state === "complete-with-errors";
      const verifying = !aborted && (session === undefined ? opening : engine.state === "working" || engine.pass !== null);

      const errors = [
        ...("work" in engine ? engine.work.errors.map((error) => ({ source: "work" as const, message: firstLine(error.cause) })) : []),
        ...("failure" in engine && engine.failure ? [{ source: "pass" as const, message: firstLine(engine.failure) }] : []),
        ...(startupFailure ? [{ source: "pass" as const, message: firstLine(startupFailure) }] : []),
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
      clearTimeout(retryTimer);
      await running;
    },
  };
}
