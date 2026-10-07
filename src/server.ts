import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import { isRawBooksEvent } from "./processing/types.ts";
import { adaptBooksEvent } from "./processing/adapters/books-adapter.ts";
import { createCatalogueProcessor } from "./processing/catalogue-processor.ts";
import { bookSync } from "./processing/handlers/book-sync.ts";
import { bookCleanup } from "./processing/handlers/book-cleanup.ts";
import { folderSync } from "./processing/handlers/folder-sync.ts";
import { folderCleanup } from "./processing/handlers/folder-cleanup.ts";
import { folderMetaSync } from "./processing/handlers/folder-meta-sync.ts";
import { buildContext } from "./context.ts";
import { createLifecycle, systemClock } from "./lifecycle/lifecycle.ts";
import { diskScanner } from "./lifecycle/disk-scanner.ts";

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 8_000;

async function main(): Promise<void> {
  try {
    const ctx = await buildContext();

    const processor = createCatalogueProcessor({
      deps: { config: ctx.config, logger: ctx.logger, fs: ctx.fs },
      handlers: {
        BookCreated: bookSync,
        BookDeleted: bookCleanup,
        FolderCreated: folderSync,
        FolderDeleted: folderCleanup,
        FolderMetaSyncRequested: folderMetaSync,
      },
    });

    const lifecycle = createLifecycle({
      scanner: diskScanner,
      processor,
      clock: systemClock,
      reconcileIntervalSeconds: config.reconcileInterval,
    });

    const initialScan = lifecycle.start();
    log.info("Server", "Lifecycle started");

    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);

        if (req.method === "POST" && url.pathname === "/events/books") {
          if (!lifecycle.accepting()) return new Response("Queue not ready", { status: 503 });

          try {
            const body = await req.json();

            if (!isRawBooksEvent(body)) {
              log.warn("Server", "Invalid books event schema", { body });

              return new Response("Invalid event", { status: 400 });
            }

            const event = adaptBooksEvent(body, ctx.dedup);

            if (event === null) return new Response("Deduplicated", { status: 202 });
            processor.submit(event);

            return new Response("OK", { status: 202 });
          } catch (error) {
            log.error("Server", "Failed to process books event", error);

            return new Response("Error", { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/resync") {
          const force = url.searchParams.get("force") === "1";
          const admission = lifecycle.requestScan({ kind: "resync", force });

          if (admission === "rejected") return new Response("Queue not ready", { status: 503 });

          return new Response(admission === "queued" ? "Resync queued" : "Resync started", { status: 202 });
        }

        if (req.method === "GET" && url.pathname === "/status") return Response.json(lifecycle.status());

        return new Response("Not found", { status: 404 });
      },
    });

    log.info("Server", "Listening", { port: server.port });

    const exitAfterStop = async (code: number) => {
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

    // The lifecycle already logged the scan error; exiting non-zero lets Docker restart instead of serving an empty catalogue.
    initialScan.catch(() => {
      log.error("Server", "Initial scan failed; exiting");

      return exitAfterStop(1);
    });

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    log.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

void main();
