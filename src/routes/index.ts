import { basename, normalize, join, isAbsolute } from "node:path";
import { config } from "../config.ts";
import { logger } from "../utils/errors.ts";
import { handleDownload, handleCover, handleThumbnail } from "./assets.ts";
import { handleOpds } from "./opds.ts";

export interface RouterContext {
  getCurrentHash: () => string;
  isRebuilding: () => boolean;
  getBookCount: () => number;
  getFolderCount: () => number;
  triggerSync: () => void;
}

export function resolveSafePath(basePath: string, userPath: string): string | null {
  if (isAbsolute(userPath)) return null;
  const fullPath = normalize(join(basePath, userPath));
  const normalizedBase = normalize(basePath);
  if (!fullPath.startsWith(normalizedBase + "/") && fullPath !== normalizedBase) {
    return null;
  }
  return fullPath;
}

export function createRouter(ctx: RouterContext) {
  return async function router(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") {
      return Response.redirect(`${config.baseUrl}/opds`, 302);
    }

    if (path === "/health") {
      return Response.json({
        status: ctx.isRebuilding() ? "rebuilding" : "ready",
        books: ctx.getBookCount(),
        folders: ctx.getFolderCount(),
        hash: ctx.getCurrentHash(),
      });
    }

    if (path === "/reset") {
      if (ctx.isRebuilding()) {
        return Response.json({ status: "busy", message: "Already rebuilding" }, { status: 429 });
      }
      logger.info("Reset", "Clearing data and resyncing...");
      await Bun.$`rm -rf ${config.dataPath}/*`.quiet();
      ctx.triggerSync();
      return Response.json({ status: "reset", message: "Data cleared, resync started" });
    }

    if (path === "/opds" || path.startsWith("/opds/")) {
      const userPath = path === "/opds" ? "" : decodeURIComponent(path.slice(6));
      const safePath = userPath === "" ? config.dataPath : resolveSafePath(config.dataPath, userPath);
      if (!safePath) return new Response("Invalid path", { status: 400 });
      const feedPath = userPath === "" ? "" : userPath;
      return handleOpds(feedPath, req, ctx.getCurrentHash());
    }

    if (path.startsWith("/download/")) {
      const userPath = decodeURIComponent(path.slice(10));
      const safePath = resolveSafePath(config.filesPath, userPath);
      if (!safePath) return new Response("Invalid path", { status: 400 });
      return handleDownload(safePath, basename(userPath));
    }

    if (path.startsWith("/cover/")) {
      const userPath = decodeURIComponent(path.slice(7));
      const safePath = resolveSafePath(config.dataPath, userPath);
      if (!safePath) return new Response("Invalid path", { status: 400 });
      return handleCover(safePath);
    }

    if (path.startsWith("/thumbnail/")) {
      const userPath = decodeURIComponent(path.slice(11));
      const safePath = resolveSafePath(config.dataPath, userPath);
      if (!safePath) return new Response("Invalid path", { status: 400 });
      return handleThumbnail(safePath);
    }

    return new Response("Not found", { status: 404 });
  };
}
