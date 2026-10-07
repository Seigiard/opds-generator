import { log } from "../logging/index.ts";
import type { CatalogueProcessor, ProcessorStatus } from "../processing/catalogue-processor.ts";
import type { EventType } from "../processing/types.ts";
import {
  INITIAL_STATE,
  transition,
  type LifecycleEffect,
  type LifecycleInput,
  type LifecycleState,
  type ScanRequest,
} from "./transition.ts";

/** Compares the books directory with the catalogue and returns the catalogue work that closes the gap. */
export interface CatalogueScanner {
  scan(request: ScanRequest, signal: AbortSignal): Promise<readonly EventType[]>;
}

export interface Clock {
  /** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };

      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

interface LifecycleOptions {
  readonly scanner: CatalogueScanner;
  readonly processor: CatalogueProcessor;
  readonly clock: Clock;
  /** Seconds between reconciliations; 0 turns them off. */
  readonly reconcileIntervalSeconds: number;
}

interface LifecycleStatus {
  readonly state: LifecycleState["phase"];
  readonly scan: LifecycleState["scan"];
  readonly followUp: LifecycleState["followUp"];
  readonly processor: ProcessorStatus;
}

/** `started`: a scan began. `queued`: a scan is running, so the request became the follow-up. `rejected`: the service is stopping. */
type ScanAdmission = "started" | "queued" | "rejected";

interface Lifecycle {
  /**
   * Starts the consumer and the initial scan. Resolves when the initial scan succeeds or the lifecycle stops first;
   * rejects with the scan's error when the initial scan fails, after the lifecycle has entered `stopping`.
   */
  start(): Promise<void>;
  requestScan(request: ScanRequest): ScanAdmission;
  /** False once stopping; watcher events are refused from then on. */
  accepting(): boolean;
  status(): LifecycleStatus;
  /** Aborts scans and the consumer, then resolves when every owned task has ended. */
  stop(): Promise<void>;
}

export function createLifecycle({ scanner, processor, clock, reconcileIntervalSeconds }: LifecycleOptions): Lifecycle {
  const controller = new AbortController();
  const { signal } = controller;
  const tasks = new Set<Promise<unknown>>();
  let state = INITIAL_STATE;
  let initialError: unknown;
  const initialScan = Promise.withResolvers<void>();

  const own = (task: Promise<unknown>): void => {
    const observed = task.catch((cause) => {
      log.error("Lifecycle", "Owned task failed", cause);
    });

    tasks.add(observed);
    void observed.then(() => tasks.delete(observed));
  };

  const runScan = async (request: ScanRequest): Promise<void> => {
    let ok = false;

    try {
      const events = await scanner.scan(request, signal);

      if (!signal.aborted) processor.submit(events);
      ok = true;
    } catch (error) {
      if (request.kind === "initial") initialError = error;

      if (!signal.aborted) log.error("Lifecycle", "Scan failed", error, { scan_kind: request.kind });
    } finally {
      dispatch({ type: "scan-finished", ok });

      if (request.kind === "initial") initialScan.resolve();
    }
  };

  const runReconcileTimer = async (): Promise<void> => {
    const intervalMs = reconcileIntervalSeconds * 1000;

    while (!signal.aborted) {
      await clock.sleep(intervalMs, signal).catch(() => {});

      if (signal.aborted) break;
      dispatch({ type: "reconcile-tick" });
    }
  };

  const execute = (effect: LifecycleEffect): void => {
    switch (effect.type) {
      case "start-scan":
        own(runScan(effect.request));
        break;
      case "arm-reconcile-timer":
        if (reconcileIntervalSeconds <= 0) break;
        own(runReconcileTimer());
        log.info("Lifecycle", `Periodic reconciliation enabled (every ${reconcileIntervalSeconds}s)`);
        break;
      case "skip-reconcile":
        log.debug("Lifecycle", "Reconciliation skipped", { reason: effect.reason });
        break;
      case "abort-work":
        controller.abort();
        break;
      case "fail-startup":
        initialScan.reject(initialError);
        break;
    }
  };

  function dispatch(input: LifecycleInput): void {
    const from = state;
    const result = transition(from, input);
    state = result.state;

    const entry = {
      from: from.phase,
      to: state.phase,
      input: input.type,
      ...(state.scan && { scan_kind: state.scan.kind, scan_force: state.scan.force }),
      follow_up: state.followUp === null ? ("none" as const) : state.followUp.force ? ("forced" as const) : ("plain" as const),
    };

    if (state === from) log.debug("Lifecycle", "No transition", entry);
    else log.info("Lifecycle", "Transition", entry);

    result.effects.forEach(execute);
  }

  const status = (): LifecycleStatus => ({
    state: state.phase,
    scan: state.scan,
    followUp: state.followUp,
    processor: processor.status(),
  });

  return {
    start() {
      own(processor.start(signal));
      processor.onBusy(() => dispatch({ type: "processor-busy" }));
      processor.onEmpty(() => dispatch({ type: "processor-empty" }));
      dispatch({ type: "scan-requested", request: { kind: "initial", force: false } });

      return initialScan.promise;
    },

    requestScan(request) {
      const before = state.phase;
      dispatch({ type: "scan-requested", request });

      if (before === "stopping") return "rejected";

      return before === "scanning" ? "queued" : "started";
    },

    accepting: () => state.phase !== "stopping",

    status,

    async stop() {
      dispatch({ type: "shutdown-requested" });
      await Promise.allSettled(tasks);
    },
  };
}
