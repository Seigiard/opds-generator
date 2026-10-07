/** What a scan is for. `initial` runs once at startup, `reconcile` comes from the timer, `resync` from an operator or the books watcher. */
type ScanKind = "initial" | "resync" | "reconcile";

export interface ScanRequest {
  readonly kind: ScanKind;
  /** Reprocess every book instead of only the changed ones. */
  readonly force: boolean;
}

/**
 * - `scanning`: a scan is running (GLOSSARY: Scanning).
 * - `accepting`: no scan is running but catalogue work is pending or active.
 * - `settled`: no scan, no pending work, no active work (GLOSSARY: Settled).
 * - `stopping`: a stop signal arrived; nothing new is taken in.
 * Every phase except `stopping` accepts watcher events and resync requests.
 */
type LifecyclePhase = "scanning" | "accepting" | "settled" | "stopping";

export interface LifecycleState {
  readonly phase: LifecyclePhase;
  /** The scan that is running; set exactly while `phase` is `scanning`. */
  readonly scan: ScanRequest | null;
  /** One coalesced scan that starts when the current scan ends. Force flags combine with OR. */
  readonly followUp: { readonly force: boolean } | null;
  /** The processor holds pending or active work. Tracked in every phase, so a finished scan lands in the right place. */
  readonly busy: boolean;
}

export type LifecycleInput =
  | { readonly type: "scan-requested"; readonly request: ScanRequest }
  | { readonly type: "scan-finished"; readonly ok: boolean }
  | { readonly type: "processor-busy" }
  | { readonly type: "processor-empty" }
  | { readonly type: "reconcile-tick" }
  | { readonly type: "shutdown-requested" };

type SkipReason = "scanning" | "accepting" | "stopping";

export type LifecycleEffect =
  | { readonly type: "start-scan"; readonly request: ScanRequest }
  /** The first scan has ended, so periodic reconciliation may begin. */
  | { readonly type: "arm-reconcile-timer" }
  | { readonly type: "skip-reconcile"; readonly reason: SkipReason }
  /** Cancel running scan work and the consumer. */
  | { readonly type: "abort-work" }
  /** The initial scan failed, so the service cannot serve a catalogue; the owner must exit non-zero. */
  | { readonly type: "fail-startup" };

interface Transition {
  readonly state: LifecycleState;
  readonly effects: readonly LifecycleEffect[];
}

export const INITIAL_STATE: LifecycleState = { phase: "settled", scan: null, followUp: null, busy: false };

const settledOrAccepting = (busy: boolean): LifecyclePhase => (busy ? "accepting" : "settled");

const startScan = (state: LifecycleState, request: ScanRequest): Transition => ({
  state: { ...state, phase: "scanning", scan: request },
  effects: [{ type: "start-scan", request }],
});

export function transition(state: LifecycleState, input: LifecycleInput): Transition {
  if (input.type === "shutdown-requested") {
    if (state.phase === "stopping") return { state, effects: [] };

    return {
      state: { ...state, phase: "stopping", scan: null, followUp: null },
      effects: [{ type: "abort-work" }],
    };
  }

  if (state.phase === "stopping") {
    // Work that was already running reports back; none of it changes the phase.
    if (input.type === "processor-busy") return { state: { ...state, busy: true }, effects: [] };

    if (input.type === "processor-empty") return { state: { ...state, busy: false }, effects: [] };

    if (input.type === "reconcile-tick") return { state, effects: [{ type: "skip-reconcile", reason: "stopping" }] };

    return { state, effects: [] };
  }

  switch (input.type) {
    case "scan-requested": {
      if (state.phase === "scanning") {
        const force = input.request.force || (state.followUp?.force ?? false);

        return { state: { ...state, followUp: { force } }, effects: [] };
      }

      return startScan(state, input.request);
    }

    case "scan-finished": {
      if (state.phase !== "scanning") return { state, effects: [] };

      if (!input.ok && state.scan?.kind === "initial") {
        return {
          state: { ...state, phase: "stopping", scan: null, followUp: null },
          effects: [{ type: "abort-work" }, { type: "fail-startup" }],
        };
      }

      const armTimer: LifecycleEffect[] = state.scan?.kind === "initial" ? [{ type: "arm-reconcile-timer" }] : [];

      if (state.followUp !== null) {
        const next = startScan({ ...state, followUp: null }, { kind: "resync", force: state.followUp.force });

        return { state: next.state, effects: [...armTimer, ...next.effects] };
      }

      return { state: { ...state, phase: settledOrAccepting(state.busy), scan: null }, effects: armTimer };
    }

    case "processor-busy":
      return { state: { ...state, busy: true, phase: state.phase === "settled" ? "accepting" : state.phase }, effects: [] };

    case "processor-empty":
      return { state: { ...state, busy: false, phase: state.phase === "accepting" ? "settled" : state.phase }, effects: [] };

    case "reconcile-tick": {
      if (state.phase === "settled") return startScan(state, { kind: "reconcile", force: false });

      return { state, effects: [{ type: "skip-reconcile", reason: state.phase }] };
    }
  }
}
