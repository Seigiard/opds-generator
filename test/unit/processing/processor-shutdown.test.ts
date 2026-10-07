import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { createCatalogueProcessor, type Handlers } from "../../../src/processing/catalogue-processor.ts";
import { createEffectCatalogueProcessor } from "../../../src/processing/catalogue-processor-effect.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/processing/types.ts";
import { toEffectHandlers } from "../../helpers/effect-variants.ts";

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

const CASCADES = 50;

// Issue #25: shutdown time and leftover work for the plain and the Effect 4 processor.
const variants = [
  { name: "plain", create: (handlers: Handlers) => createCatalogueProcessor({ deps, handlers }) },
  { name: "effect", create: (handlers: Handlers) => createEffectCatalogueProcessor({ deps, handlers: toEffectHandlers(handlers) }) },
];

/** Resolves `CLEANUP_MS` after the signal aborts, as a handler that tidies up before it returns. */
function afterAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => setTimeout(resolve, CLEANUP_MS);

    if (!signal || signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

describe.each(variants)("Processor shutdown ($name)", ({ create }) => {
  async function measure(scenario: "active-handler" | "pending-cascades") {
    const durations: number[] = [];
    let leftover = 0;
    let startedAfterStop = 0;
    let activeAtStop = 0;

    for (let round = 0; round < ROUNDS; round++) {
      // #given a processor caught in the middle of the scenario
      const tally = { started: 0, ended: 0 };
      let stopping = false;

      const track = async (work: () => Promise<readonly EventType[]>) => {
        tally.started++;

        if (stopping) startedAfterStop++;

        try {
          return ok(await work());
        } finally {
          tally.ended++;
        }
      };

      const processor = create({
        BookCreated: (_event, handlerDeps) =>
          track(async () => {
            if (scenario === "pending-cascades") {
              return Array.from({ length: CASCADES }, (_, i): EventType => ({ _tag: "FolderMetaSyncRequested", path: `/test/data/${i}` }));
            }

            await afterAbort(handlerDeps.signal);

            return [];
          }),
        FolderMetaSyncRequested: (_event, handlerDeps) =>
          track(async () => {
            await afterAbort(handlerDeps.signal);

            return [];
          }),
      });

      const controller = new AbortController();
      const task = processor.start(controller.signal);
      processor.submit({ _tag: "BookCreated", parent: "/test/files", name: "a.epub" });
      await Bun.sleep(15);

      // #when stop is called
      activeAtStop += tally.started - tally.ended;
      const startedAt = performance.now();
      stopping = true;
      controller.abort();
      await task;
      durations.push(performance.now() - startedAt);
      await Bun.sleep(5);

      // #then nothing it owned is still running and no pending work started
      leftover += tally.started - tally.ended;
    }

    durations.sort((a, b) => a - b);

    return { medianMs: durations[Math.floor(ROUNDS / 2)]!, maxMs: durations.at(-1)!, leftover, startedAfterStop, activeAtStop };
  }

  for (const scenario of ["active-handler", "pending-cascades"] as const) {
    test(`stop during ${scenario} waits for cooperative cleanup and leaves nothing running`, async () => {
      // #given / #when
      const result = await measure(scenario);
      console.log(
        `  processor shutdown ${scenario}: median ${result.medianMs.toFixed(1)} ms, max ${result.maxMs.toFixed(1)} ms, ` +
          `leftover ${result.leftover}, started after stop ${result.startedAfterStop}`,
      );
      // #then a handler was active in every round, and none survives stop or starts after it
      expect({ activeAtStop: result.activeAtStop, leftover: result.leftover, startedAfterStop: result.startedAfterStop }).toEqual({
        activeAtStop: ROUNDS,
        leftover: 0,
        startedAfterStop: 0,
      });
      expect(result.medianMs).toBeLessThan(CLEANUP_MS * 5);
    });
  }
});
