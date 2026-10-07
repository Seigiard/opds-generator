import { describe, test, expect } from "bun:test";
import { transition, type LifecycleInput, type LifecycleState, type ScanRequest } from "../../../src/lifecycle/transition.ts";

const state = (overrides: Partial<LifecycleState>): LifecycleState => ({
  phase: "settled",
  scan: null,
  followUp: null,
  busy: false,
  ...overrides,
});

const resync = (force: boolean): LifecycleInput => ({ type: "scan-requested", request: { kind: "resync", force } });

const scanning = (scan: ScanRequest, overrides: Partial<LifecycleState> = {}) => state({ phase: "scanning", scan, ...overrides });

describe("transition", () => {
  test("reconcile tick while a handler is active does not start a scan", () => {
    // #given a catalogue with no scan whose processor is busy
    const accepting = state({ phase: "accepting", busy: true });
    // #when the reconcile timer fires
    const result = transition(accepting, { type: "reconcile-tick" });
    // #then nothing starts and the skip is reported
    expect(result.state).toEqual(accepting);
    expect(result.effects).toEqual([{ type: "skip-reconcile", reason: "accepting" }]);
  });

  test("reconcile tick during a scan is skipped", () => {
    // #given
    const running = scanning({ kind: "initial", force: false });
    // #when
    const result = transition(running, { type: "reconcile-tick" });
    // #then
    expect(result.state).toEqual(running);
    expect(result.effects).toEqual([{ type: "skip-reconcile", reason: "scanning" }]);
  });

  test("reconcile tick when Settled starts a plain reconcile scan", () => {
    // #given
    const settled = state({});
    // #when
    const result = transition(settled, { type: "reconcile-tick" });
    // #then
    expect(result.state.phase).toBe("scanning");
    expect(result.effects).toEqual([{ type: "start-scan", request: { kind: "reconcile", force: false } }]);
  });

  test("a handler going busy before the tick then empty lets the next tick scan", () => {
    // #given a Settled catalogue that receives work
    const busy = transition(state({}), { type: "processor-busy" }).state;
    // #when the tick arrives while busy, then the work drains and another tick arrives
    const first = transition(busy, { type: "reconcile-tick" });
    const drained = transition(first.state, { type: "processor-empty" }).state;
    const second = transition(drained, { type: "reconcile-tick" });
    // #then only the second tick scans
    expect(first.effects).toEqual([{ type: "skip-reconcile", reason: "accepting" }]);
    expect(second.effects).toEqual([{ type: "start-scan", request: { kind: "reconcile", force: false } }]);
  });

  test("processor edges move between accepting and settled", () => {
    // #given
    const settled = state({});
    // #when
    const busy = transition(settled, { type: "processor-busy" });
    const empty = transition(busy.state, { type: "processor-empty" });
    // #then
    expect(busy.state).toEqual(state({ phase: "accepting", busy: true }));
    expect(empty.state).toEqual(state({}));
  });

  test("processor edges during a scan are remembered without leaving Scanning", () => {
    // #given
    const running = scanning({ kind: "initial", force: false });
    // #when
    const busy = transition(running, { type: "processor-busy" });
    // #then
    expect(busy.state).toEqual(scanning({ kind: "initial", force: false }, { busy: true }));
    expect(transition(busy.state, { type: "processor-empty" }).state).toEqual(running);
  });

  test("a finished scan lands in accepting when work is queued", () => {
    // #given
    const running = scanning({ kind: "resync", force: false }, { busy: true });
    // #when
    const result = transition(running, { type: "scan-finished", ok: true });
    // #then
    expect(result.state).toEqual(state({ phase: "accepting", busy: true }));
    expect(result.effects).toEqual([]);
  });

  test("a finished scan lands in Settled when the processor is empty", () => {
    // #given
    const running = scanning({ kind: "reconcile", force: false });
    // #when
    const result = transition(running, { type: "scan-finished", ok: false });
    // #then
    expect(result.state).toEqual(state({}));
  });

  test("the finished initial scan arms the reconcile timer once", () => {
    // #given
    const initial = scanning({ kind: "initial", force: false });
    // #when
    const result = transition(initial, { type: "scan-finished", ok: true });
    // #then
    expect(result.effects).toEqual([{ type: "arm-reconcile-timer" }]);
    expect(transition(scanning({ kind: "resync", force: false }), { type: "scan-finished", ok: true }).effects).toEqual([]);
  });

  test("a request when not scanning starts that scan", () => {
    // #given
    const settled = state({});
    // #when
    const result = transition(settled, resync(true));
    // #then
    expect(result.state).toEqual(scanning({ kind: "resync", force: true }));
    expect(result.effects).toEqual([{ type: "start-scan", request: { kind: "resync", force: true } }]);
  });

  test("requests during a scan coalesce into one follow-up with force OR'd", () => {
    // #given
    const running = scanning({ kind: "initial", force: false });
    // #when two plain requests and a forced one, then a plain one again
    const a = transition(running, resync(false));
    const b = transition(a.state, resync(true));
    const c = transition(b.state, resync(false));
    // #then there is one follow-up and the force flag stays set
    expect(a.state.followUp).toEqual({ force: false });
    expect(b.state.followUp).toEqual({ force: true });
    expect(c.state.followUp).toEqual({ force: true });
    expect([a, b, c].flatMap((step) => step.effects)).toEqual([]);
  });

  test("a finished scan starts the follow-up exactly once", () => {
    // #given a scan with a forced follow-up queued
    const running = scanning({ kind: "initial", force: false }, { followUp: { force: true } });
    // #when the scan ends, then the follow-up ends
    const first = transition(running, { type: "scan-finished", ok: true });
    const second = transition(first.state, { type: "scan-finished", ok: true });
    // #then the follow-up ran as a forced resync and nothing else follows
    expect(first.state).toEqual(scanning({ kind: "resync", force: true }));
    expect(first.effects).toEqual([{ type: "arm-reconcile-timer" }, { type: "start-scan", request: { kind: "resync", force: true } }]);
    expect(second.state).toEqual(state({}));
    expect(second.effects).toEqual([]);
  });

  test("shutdown from any phase stops, drops the follow-up and aborts work", () => {
    // #given
    const running = scanning({ kind: "resync", force: false }, { followUp: { force: true }, busy: true });
    // #when
    const result = transition(running, { type: "shutdown-requested" });
    // #then
    expect(result.state).toEqual(state({ phase: "stopping", busy: true }));
    expect(result.effects).toEqual([{ type: "abort-work" }]);
    expect(transition(state({}), { type: "shutdown-requested" }).state.phase).toBe("stopping");
  });

  test("Stopping takes no new scans, ignores a finishing scan and a tick, and stops only once", () => {
    // #given
    const stopping = state({ phase: "stopping" });
    // #when
    const request = transition(stopping, resync(true));
    const finished = transition(stopping, { type: "scan-finished", ok: true });
    const tick = transition(stopping, { type: "reconcile-tick" });
    const again = transition(stopping, { type: "shutdown-requested" });
    // #then
    expect(request).toEqual({ state: stopping, effects: [] });
    expect(finished).toEqual({ state: stopping, effects: [] });
    expect(tick.effects).toEqual([{ type: "skip-reconcile", reason: "stopping" }]);
    expect(again).toEqual({ state: stopping, effects: [] });
  });
});
