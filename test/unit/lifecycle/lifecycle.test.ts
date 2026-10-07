import { describe, test, expect } from "bun:test";
import { ok } from "neverthrow";
import { createLifecycle, type CatalogueScanner, type Clock } from "../../../src/lifecycle/lifecycle.ts";
import { createCatalogueProcessor, type CatalogueProcessor, type Handlers } from "../../../src/processing/catalogue-processor.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/processing/types.ts";
import type { ScanRequest } from "../../../src/lifecycle/transition.ts";

const deps: HandlerDeps = {
  config: { filesPath: "/test/files", dataPath: "/test/data", port: 3000, reconcileInterval: 1800 },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fs: {
    mkdir: async () => {},
    rm: async () => {},
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => false, size: 0 }),
    exists: async () => false,
    writeFile: async () => {},
    atomicWrite: async () => {},
    symlink: async () => {},
    unlink: async () => {},
  },
};

const book = (name: string): EventType => ({ _tag: "BookCreated", parent: "/test/files", name });

function gate() {
  let open = () => {};

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

const flush = () => Bun.sleep(15);

/** A clock whose sleeps end only when the test calls `tick`. */
function manualClock() {
  const sleepers: Array<() => void> = [];
  const requested: number[] = [];

  const clock: Clock = {
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        requested.push(ms);
        sleepers.push(resolve);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };

  return { clock, requested, tick: () => sleepers.splice(0).forEach((wake) => wake()) };
}

function fixture(
  options: {
    scan?: (request: ScanRequest, signal: AbortSignal) => Promise<readonly EventType[]>;
    handlers?: Handlers;
    interval?: number;
  } = {},
) {
  const scans: ScanRequest[] = [];

  const scanner: CatalogueScanner = {
    scan: async (request, signal) => {
      scans.push(request);

      return options.scan ? options.scan(request, signal) : [];
    },
  };

  const processor = createCatalogueProcessor({ deps, handlers: options.handlers ?? { BookCreated: async () => ok([]) } });
  const time = manualClock();
  const lifecycle = createLifecycle({ scanner, processor, clock: time.clock, reconcileIntervalSeconds: options.interval ?? 60 });

  return { lifecycle, scans, time, processor };
}

describe("Lifecycle", () => {
  test("runs the initial scan, queues its work and ends Settled once the work drains", async () => {
    // #given a scan that finds one book
    const { lifecycle, scans } = fixture({ scan: async () => [book("a.epub")] });
    // #when the lifecycle starts and everything finishes
    lifecycle.start();
    await flush();
    // #then one initial scan ran and the catalogue is Settled
    expect(scans).toEqual([{ kind: "initial", force: false }]);
    expect(lifecycle.status()).toEqual({ state: "settled", scan: null, followUp: null, processor: { pending: 0, active: null } });
    await lifecycle.stop();
  });

  test("reports scanning during a scan, then accepting while a handler is active", async () => {
    // #given a scan held open and a handler held open
    const scanGate = gate();
    const handlerGate = gate();

    const { lifecycle } = fixture({
      scan: async () => {
        await scanGate.promise;

        return [book("a.epub")];
      },
      handlers: {
        BookCreated: async () => {
          await handlerGate.promise;

          return ok([]);
        },
      },
    });

    // #when
    lifecycle.start();
    const during = lifecycle.status().state;
    scanGate.open();
    await flush();
    const working = lifecycle.status();
    handlerGate.open();
    await flush();
    // #then
    expect(during).toBe("scanning");
    expect(working.state).toBe("accepting");
    expect(working.processor.active).toEqual({ kind: "BookCreated", path: "/test/files/a.epub" });
    expect(lifecycle.status().state).toBe("settled");
    await lifecycle.stop();
  });

  test("reconciliation does not start while a handler is active and starts once Settled", async () => {
    // #given the initial scan done and a handler still running
    const handlerGate = gate();

    const { lifecycle, scans, time } = fixture({
      scan: async (request) => (request.kind === "initial" ? [book("a.epub")] : []),
      handlers: {
        BookCreated: async () => {
          await handlerGate.promise;

          return ok([]);
        },
      },
    });

    lifecycle.start();
    await flush();
    // #when the timer fires while the handler runs, then again after it ends
    time.tick();
    await flush();
    const duringHandler = scans.length;
    handlerGate.open();
    await flush();
    time.tick();
    await flush();
    // #then only the second tick scanned, as a plain reconcile, after a 60 s sleep
    expect(duringHandler).toBe(1);
    expect(scans.slice(1)).toEqual([{ kind: "reconcile", force: false }]);
    expect(time.requested[0]).toBe(60_000);
    await lifecycle.stop();
  });

  test("requestScan reports started, queued during a scan, and runs one follow-up with force OR'd", async () => {
    // #given an initial scan held open
    const scanGate = gate();

    const { lifecycle, scans } = fixture({
      scan: async (request) => {
        if (request.kind === "initial") await scanGate.promise;

        return [];
      },
    });

    lifecycle.start();

    // #when three resyncs arrive during the scan, one of them forced
    const admissions = [
      lifecycle.requestScan({ kind: "resync", force: false }),
      lifecycle.requestScan({ kind: "resync", force: true }),
      lifecycle.requestScan({ kind: "resync", force: false }),
    ];

    scanGate.open();
    await flush();
    // #then they queue, and exactly one forced follow-up runs
    expect(admissions).toEqual(["queued", "queued", "queued"]);
    expect(scans).toEqual([
      { kind: "initial", force: false },
      { kind: "resync", force: true },
    ]);
    expect(lifecycle.requestScan({ kind: "resync", force: false })).toBe("started");
    await lifecycle.stop();
  });

  test("a failed resync still ends in Settled and the next request runs", async () => {
    // #given a scanner whose second scan (the resync) throws once
    let calls = 0;

    const { lifecycle, scans } = fixture({
      scan: async () => {
        if (++calls === 2) throw new Error("disk gone");

        return [];
      },
    });

    lifecycle.start();
    await flush();
    // #when a resync fails and another one is requested
    lifecycle.requestScan({ kind: "resync", force: false });
    await flush();
    const state = lifecycle.status().state;
    lifecycle.requestScan({ kind: "resync", force: false });
    await flush();
    // #then
    expect(state).toBe("settled");
    expect(scans).toHaveLength(3);
    await lifecycle.stop();
  });

  test("a failed initial scan enters Stopping, rejects start() with the error and refuses requests", async () => {
    // #given a scanner that throws on the initial scan
    const { lifecycle, scans } = fixture({
      scan: async () => {
        throw new Error("books unreadable");
      },
    });

    // #when
    const outcome = await lifecycle.start().then(
      () => "resolved",
      (error: Error) => error.message,
    );

    // #then
    expect(outcome).toBe("books unreadable");
    expect(lifecycle.status().state).toBe("stopping");
    expect(lifecycle.requestScan({ kind: "resync", force: false })).toBe("rejected");
    expect(scans).toHaveLength(1);
    await lifecycle.stop();
  });

  test("start() resolves once the initial scan succeeds", async () => {
    // #given
    const { lifecycle } = fixture();
    // #when
    const outcome = await lifecycle.start().then(() => "resolved");
    // #then
    expect(outcome).toBe("resolved");
    await lifecycle.stop();
  });

  test("stop during a scan aborts it, drops its work and the follow-up, and resolves", async () => {
    // #given a scan that waits for its abort signal and a queued follow-up
    const { lifecycle, scans, processor } = fixture({
      scan: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve([book("late.epub")]), { once: true });
        }),
    });

    lifecycle.start();
    lifecycle.requestScan({ kind: "resync", force: true });
    // #when
    await lifecycle.stop();
    // #then the scan ended, nothing was submitted, no follow-up ran, and new requests are rejected
    expect(scans).toHaveLength(1);
    expect(processor.status().pending).toBe(0);
    expect(lifecycle.status().state).toBe("stopping");
    expect(lifecycle.accepting()).toBe(false);
    expect(lifecycle.requestScan({ kind: "resync", force: false })).toBe("rejected");
  });

  test("stop ends the reconcile timer and no tick scans afterwards", async () => {
    // #given a running timer
    const { lifecycle, scans, time } = fixture();
    lifecycle.start();
    await flush();
    // #when
    await lifecycle.stop();
    time.tick();
    await flush();
    // #then
    expect(scans).toHaveLength(1);
  });

  test("a zero interval never arms the timer", async () => {
    // #given
    const { lifecycle, time } = fixture({ interval: 0 });
    // #when
    lifecycle.start();
    await flush();
    // #then
    expect(time.requested).toEqual([]);
    await lifecycle.stop();
  });

  test("logs a rejecting processor start without raising an unhandled rejection", async () => {
    // #given a processor whose consumer task rejects after startup
    const failure = new Error("consumer crashed");
    const scanner: CatalogueScanner = { scan: async () => [] };

    const processor: CatalogueProcessor = {
      submit: () => {},
      start: () => Promise.reject(failure),
      onBusy: () => () => {},
      onEmpty: () => () => {},
      status: () => ({ pending: 0, active: null }),
    };

    const lifecycle = createLifecycle({ scanner, processor, clock: manualClock().clock, reconcileIntervalSeconds: 0 });
    const errors: string[] = [];
    const originalError = console.error;
    const unhandled: unknown[] = [];

    const onUnhandled = (cause: Error) => {
      unhandled.push(cause);
    };

    process.on("unhandledRejection", onUnhandled);
    console.error = (entry?: string, ...optionalParams: string[]) => {
      errors.push(String(entry));
      originalError(entry, ...optionalParams);
    };

    try {
      // #when
      await lifecycle.start();
      await flush();
      await lifecycle.stop();
      await flush();
    } finally {
      console.error = originalError;
      process.off("unhandledRejection", onUnhandled);
    }

    // #then the failure is observed by lifecycle only
    expect(errors.map((entry) => JSON.parse(entry))).toEqual([
      expect.objectContaining({ level: "error", tag: "Lifecycle", msg: "Owned task failed", error: "consumer crashed" }),
    ]);
    expect(unhandled).toEqual([]);
  });
});
