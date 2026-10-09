import { log } from "./logging/index.ts";
import { adaptBooksEvent } from "./processing/adapters/books-adapter.ts";
import { isRawBooksEvent, type EventType } from "./processing/types.ts";

export interface CatalogueHttpRuntime {
  accepting(): boolean;
  submit(event: EventType): Promise<void>;
  requestScan(request: { readonly kind: "resync"; readonly force: boolean }): Promise<"started" | "queued" | "rejected">;
  status(): Promise<object>;
}

/** The Bun-local routes. nginx retains authentication and external routing. */
export function createCatalogueHttpHandler(runtime: CatalogueHttpRuntime) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/events/books") {
      if (!runtime.accepting()) return new Response("Not accepting", { status: 503 });

      try {
        const body = await req.json();

        if (!isRawBooksEvent(body)) {
          log.warn("Server", "Invalid books event schema", { body });

          return new Response("Invalid event", { status: 400 });
        }

        const event = adaptBooksEvent(body);

        if (event === null) return new Response("Ignored", { status: 202 });
        await runtime.submit(event);

        return new Response("OK", { status: 202 });
      } catch (error) {
        log.error("Server", "Failed to process books event", error);

        return new Response("Error", { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/resync") {
      const force = url.searchParams.get("force") === "1";
      const admission = await runtime.requestScan({ kind: "resync", force });

      if (admission === "rejected") return new Response("Not accepting", { status: 503 });

      return new Response(admission === "queued" ? "Resync queued" : "Resync started", { status: 202 });
    }

    if (req.method === "GET" && url.pathname === "/status") return Response.json(await runtime.status());

    return new Response("Not found", { status: 404 });
  };
}
