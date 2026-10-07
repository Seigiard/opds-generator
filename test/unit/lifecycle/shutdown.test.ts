import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { createLifecycle, type CatalogueScanner, type Clock } from "../../../src/lifecycle/lifecycle.ts";
import { createCatalogueProcessor } from "../../../src/processing/catalogue-processor.ts";
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

const CLEANUP_MS = 20;

const ROUNDS = 15;

const book: EventType = { _tag: "BookCreated", parent: "/test/files", name: "a.epub" };

/** Resolves `CLEANUP_MS` after the signal aborts, as a scan or handler that tidies up before it returns. */
function afterAbort<T>(signal: AbortSignal, value: T): Promise<T> {
  return new Promise((resolve) => {
    const finish = () => setTimeout(() => resolve(value), CLEANUP_MS);

    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

function build(work: { hangingScan: ScanRequest["kind"] | null; hangingHandler: boolean }) {
  const tally = { scansStarted: 0, scansEnded: 0, handlersStarted: 0, handlersEnded: 0, sleepsOpen: 0 };

  const scanner: CatalogueScanner = {
    async scan(request: ScanRequest, signal) {
      tally.scansStarted++;

      try {
        if (request.kind === work.hangingScan) return await afterAbort(signal, []);

        return request.kind === "initial" ? [book] : [];
      } finally {
        tally.scansEnded++;
      }
    },
  };

  const clock: Clock = {
    sleep: (_ms, signal) =>
      new Promise((_resolve, reject) => {
        tally.sleepsOpen++;

        signal.addEventListener(
          "abort",
          () => {
            tally.sleepsOpen--;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };

  const processor = createCatalogueProcessor({
    deps,
    handlers: {
      BookCreated: async (_event, handlerDeps) => {
        tally.handlersStarted++;

        try {
          if (work.hangingHandler) await afterAbort(handlerDeps.signal ?? new AbortController().signal, null);

          return ok<readonly EventType[]>([]);
        } finally {
          tally.handlersEnded++;
        }
      },
    },
  });

  return { lifecycle: createLifecycle({ scanner, processor, clock, reconcileIntervalSeconds: 60 }), tally };
}

async function measure(scenario: "initial-scan" | "resync" | "active-handler") {
  const durations: number[] = [];
  let leftover = 0;

  for (let round = 0; round < ROUNDS; round++) {
    // #given a lifecycle caught in the middle of the scenario
    const { lifecycle, tally } = build({
      hangingScan: scenario === "initial-scan" ? "initial" : scenario === "resync" ? "resync" : null,
      hangingHandler: scenario === "active-handler",
    });

    lifecycle.start();
    await Bun.sleep(15);

    if (scenario === "resync") {
      lifecycle.requestScan({ kind: "resync", force: false });
      lifecycle.requestScan({ kind: "resync", force: true });
      await Bun.sleep(10);
    }

    // #when stop is called
    const startedAt = performance.now();
    await lifecycle.stop();
    durations.push(performance.now() - startedAt);

    // #then nothing it owned is still running
    leftover += tally.scansStarted - tally.scansEnded + (tally.handlersStarted - tally.handlersEnded) + tally.sleepsOpen;
  }

  durations.sort((a, b) => a - b);

  return { medianMs: durations[Math.floor(ROUNDS / 2)]!, maxMs: durations.at(-1)!, leftover };
}

describe("Shutdown", () => {
  for (const scenario of ["initial-scan", "resync", "active-handler"] as const) {
    test(`stop during ${scenario} waits for cooperative cleanup and leaves nothing running`, async () => {
      // #given / #when
      const result = await measure(scenario);
      console.log(
        `  shutdown ${scenario}: median ${result.medianMs.toFixed(1)} ms, max ${result.maxMs.toFixed(1)} ms, leftover ${result.leftover}`,
      );
      // #then it ends once the cooperative cleanup is done, and no task, handler or sleep survives
      expect(result.leftover).toBe(0);
      expect(result.medianMs).toBeLessThan(CLEANUP_MS * 5);
    });
  }

  test("stop waits for a scan that ignores its signal", async () => {
    // #given a scan that takes 80 ms and never looks at the signal
    let ended = false;

    const scanner: CatalogueScanner = {
      scan: async () => {
        await Bun.sleep(80);
        ended = true;

        return [];
      },
    };

    const processor = createCatalogueProcessor({ deps, handlers: {} });

    const lifecycle = createLifecycle({
      scanner,
      processor,
      clock: { sleep: () => new Promise(() => {}) },
      reconcileIntervalSeconds: 0,
    });

    lifecycle.start();
    await Bun.sleep(5);
    // #when
    const startedAt = performance.now();
    await lifecycle.stop();
    const elapsed = performance.now() - startedAt;
    console.log(`  shutdown uncooperative scan: ${elapsed.toFixed(1)} ms`);
    // #then stop did not return before the scan did
    expect(ended).toBe(true);
  });
});
