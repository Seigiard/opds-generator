import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { HandlerDeps } from "../../../src/context.ts";
import { createLiveEngineLifecycle } from "../../../src/lifecycle/live-engine-lifecycle.ts";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();

  return { promise, open: () => resolve() };
}

function deps(): HandlerDeps {
  return {
    config: { filesPath: "/books", dataPath: "/data", port: 3000, reconcileInterval: 0 },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    fs: {
      mkdir: async () => undefined,
      rm: async () => undefined,
      readdir: async () => [],
      stat: async () => ({ isDirectory: () => false, size: 0 }),
      exists: async () => false,
      writeFile: async () => undefined,
      atomicWrite: async () => undefined,
      symlink: async () => undefined,
      unlink: async () => undefined,
    },
  };
}

test("stop waits for in-flight admission before resolving", async () => {
  // #given a lifecycle whose engine admission has started but not settled
  const entered = gate();
  const release = gate();

  const lifecycle = createLiveEngineLifecycle(deps(), {
    startCatalogue: () =>
      Effect.succeed({
        ready: Effect.void,
        awaitCompletion: Effect.void,
        notify: () => Effect.succeed("started" as const),
        requestPass: () =>
          Effect.gen(function* () {
            entered.open();
            // oxlint-disable-next-line opds/no-direct-effect-promise -- Test double models an external admission Promise that must outlive scope abort until stop joins it.
            yield* Effect.promise(() => release.promise);

            return "started" as const;
          }),
        status: Effect.succeed({
          state: "complete",
          pass: null,
          followUp: null,
          failure: null,
          availability: null,
          work: { state: "complete", pending: 0, active: null, errors: [] },
        }),
      }),
  });

  await lifecycle.start();
  const admission = lifecycle.requestScan({ kind: "resync", force: true });
  await entered.promise;
  let stopped = false;

  // #when stop races with that in-flight admission
  const stopping = lifecycle.stop().then(() => {
    stopped = true;
  });

  await Bun.sleep(10);
  const duringStop = stopped;
  release.open();
  await stopping;
  await admission;

  // #then stop resolves only after admission settles
  expect(duringStop).toBe(false);
});

test("stop rejects new admission after abort", async () => {
  // #given a started lifecycle with observable engine admission calls
  const requests: unknown[] = [];
  const notifications: unknown[] = [];

  const lifecycle = createLiveEngineLifecycle(deps(), {
    startCatalogue: () =>
      Effect.succeed({
        ready: Effect.void,
        awaitCompletion: Effect.void,
        notify: (paths) => {
          notifications.push(paths);

          return Effect.succeed("started" as const);
        },
        requestPass: (request) => {
          requests.push(request);

          return Effect.succeed("started" as const);
        },
        status: Effect.succeed({
          state: "complete",
          pass: null,
          followUp: null,
          failure: null,
          availability: null,
          work: { state: "complete", pending: 0, active: null, errors: [] },
        }),
      }),
  });

  await lifecycle.start();

  // #when stop closes admission
  await lifecycle.stop();

  // #then later public inputs are rejected without reaching the engine
  expect({
    accepting: lifecycle.accepting(),
    request: await lifecycle.requestScan({ kind: "resync", force: true }),
    notifications,
    requests,
  }).toEqual({ accepting: false, request: "rejected", notifications: [], requests: [] });

  await lifecycle.submit(CatalogueEvent.BookCreated({ parent: "/books", name: "Book.fb2" }));
  expect({ notifications, requests }).toEqual({ notifications: [], requests: [] });
});
