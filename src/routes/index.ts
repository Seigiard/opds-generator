import { normalize, join, isAbsolute } from "node:path";
import { config } from "../config.ts";
import { logger } from "../utils/errors.ts";

export interface RouterContext {
  getCurrentHash: () => string;
  isRebuilding: () => boolean;
  getBookCount: () => number;
  getFolderCount: () => number;
  triggerSync: () => void;
}

export function resolveSafePath(basePath: string, userPath: string): string | null {
  if (userPath.includes("\x00")) return null;
  if (isAbsolute(userPath)) return null;
  const fullPath = normalize(join(basePath, userPath));
  const normalizedBase = normalize(basePath);
  if (!fullPath.startsWith(normalizedBase + "/") && fullPath !== normalizedBase) {
    return null;
  }
  return fullPath;
}

const STATIC_PATH = "static";

export function createRouter(ctx: RouterContext) {
  return async function router(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Root and /opds → feed.xml
    if (path === "/" || path === "/opds") {
      return Response.redirect("/feed.xml", 302);
    }

    // Static files from /static folder
    if (path.startsWith("/static/")) {
      const fileName = path.slice("/static/".length);
      const safePath = resolveSafePath(STATIC_PATH, fileName);
      if (!safePath) {
        return new Response("Invalid path", { status: 400 });
      }
      const file = Bun.file(safePath);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(file);
    }

    // Health check
    if (path === "/health") {
      return Response.json({
        status: ctx.isRebuilding() ? "rebuilding" : "ready",
        books: ctx.getBookCount(),
        folders: ctx.getFolderCount(),
        hash: ctx.getCurrentHash(),
      });
    }

    // Reset cache
    if (path === "/reset") {
      if (ctx.isRebuilding()) {
        return Response.json({ status: "busy", message: "Already rebuilding" }, { status: 429 });
      }
      logger.info("Reset", "Clearing data and resyncing...");
      await Bun.$`rm -rf ${config.dataPath}/*`.quiet();
      ctx.triggerSync();
      return Response.json({ status: "reset", message: "Data cleared, resync started" });
    }

    // Static files from /data
    const userPath = decodeURIComponent(path.slice(1)); // remove leading /
    const safePath = resolveSafePath(config.dataPath, userPath);
    if (!safePath) {
      return new Response("Invalid path", { status: 400 });
    }

    const file = Bun.file(safePath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(file);
  };
}
