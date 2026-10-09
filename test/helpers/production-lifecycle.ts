import type { HandlerDeps } from "../../src/context.ts";
import { createLiveEngineLifecycle } from "../../src/lifecycle/live-engine-lifecycle.ts";

/**
 * Starts the production lifecycle and exposes its stop as an abortable task.
 * `abort()` requests the stop; `task` resolves once the lifecycle joined its owned work.
 */
export function startProductionLifecycle(deps: HandlerDeps) {
  const lifecycle = createLiveEngineLifecycle(deps);
  void lifecycle.start().catch(() => undefined);
  const stopped = Promise.withResolvers<void>();
  let stopping: Promise<void> | undefined;

  return {
    lifecycle,
    active: async () => (await lifecycle.status()).work.active,
    controller: {
      abort: (_reason?: Error) => {
        stopping ??= lifecycle.stop().then(() => stopped.resolve());
      },
    },
    task: stopped.promise,
  };
}
