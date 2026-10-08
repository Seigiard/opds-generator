import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import { createCatalogueHttpHandler } from "./catalogue-http.ts";
import { createEffectCatalogueProcessor } from "./processing/catalogue-processor-effect.ts";
import { bookSyncEffect } from "./processing/handlers/book-sync-effect.ts";
import { bookCleanupEffect } from "./processing/handlers/book-cleanup-effect.ts";
import { folderSyncEffect } from "./processing/handlers/folder-sync-effect.ts";
import { folderCleanupEffect } from "./processing/handlers/folder-cleanup-effect.ts";
import { folderMetaSyncEffect } from "./processing/handlers/folder-meta-sync-effect.ts";
import { buildContext } from "./context.ts";
import { createLifecycle, systemClock } from "./lifecycle/lifecycle.ts";
import { diskScanner } from "./lifecycle/disk-scanner.ts";
import { createLiveEngineLifecycle } from "./lifecycle/live-engine-lifecycle.ts";

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 8_000;

async function main(): Promise<void> {
  try {
    const ctx = await buildContext();

    const processor = createEffectCatalogueProcessor({
      deps: { config: ctx.config, logger: ctx.logger, fs: ctx.fs },
      handlers: {
        BookCreated: bookSyncEffect,
        BookDeleted: bookCleanupEffect,
        FolderCreated: folderSyncEffect,
        FolderDeleted: folderCleanupEffect,
        FolderMetaSyncRequested: folderMetaSyncEffect,
      },
    });

    const onFatal = (cause: unknown) => {
      log.error("Server", "Processor failed; exiting", cause);

      void exitAfterStop(1);
    };

    const legacy = createLifecycle({
      scanner: diskScanner,
      processor,
      clock: systemClock,
      reconcileIntervalSeconds: config.reconcileInterval,
      onFatal,
    });

    const shared = process.env.SYNC_ENGINE === "shared";
    const lifecycle = shared ? createLiveEngineLifecycle(ctx, { onFatal }) : { ...legacy, submit: processor.submit };
    // A live engine retains dirty hints itself. Time-window dedup could drop a replacement during processing.
    const dedup = shared ? { shouldProcess: () => true } : ctx.dedup;

    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      fetch: createCatalogueHttpHandler(lifecycle, dedup),
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

    const initialScan = lifecycle.start();
    log.info("Server", "Lifecycle started");

    // The lifecycle already logged the scan error; exiting non-zero lets Docker restart instead of serving an empty catalogue.
    initialScan.catch(() => {
      if (stopping) return;
      log.error("Server", "Initial scan failed; exiting");

      return exitAfterStop(1);
    });
  } catch (error) {
    log.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

void main();
