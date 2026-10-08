import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import { createCatalogueHttpHandler } from "./catalogue-http.ts";
import { buildContext } from "./context.ts";
import { createLiveEngineLifecycle } from "./lifecycle/live-engine-lifecycle.ts";
import { removeHeapSnapshotLeftovers } from "./lifecycle/legacy-data.ts";

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 8_000;

async function main(): Promise<void> {
  try {
    const ctx = await buildContext();

    const onFatal = (cause: unknown) => {
      log.error("Server", "Synchronization failed without usable output; exiting", cause);

      void exitAfterStop(1);
    };

    const lifecycle = createLiveEngineLifecycle(ctx, { onFatal });

    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      fetch: createCatalogueHttpHandler(lifecycle),
    });

    log.info("Server", "Listening", { port: server.port });

    let stopping = false;

    const exitAfterStop = async (code: number) => {
      if (stopping) return;
      stopping = true;
      server.stop();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const timeout = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS);
      });

      const outcome = await Promise.race([lifecycle.stop().then(() => "stopped" as const), timeout]);
      clearTimeout(timeoutId);

      if (outcome === "timeout") {
        log.warn("Server", "Shutdown deadline reached; active work or cleanup is unfinished");
      }

      process.exit(code);
    };

    const shutdown = () => {
      log.info("Server", "Shutting down");

      return exitAfterStop(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    await removeHeapSnapshotLeftovers(config.dataPath);

    // A rejection is reported once through onFatal, which exits non-zero so Docker restarts the container.
    lifecycle.start().catch(() => undefined);
    log.info("Server", "Lifecycle started");
  } catch (error) {
    log.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

void main();
