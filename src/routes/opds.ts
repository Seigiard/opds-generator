import { join } from "node:path";
import { config } from "../config.ts";

export async function handleOpds(
  feedPath: string,
  req: Request,
  currentHash: string,
): Promise<Response> {
  const feedFile = Bun.file(join(config.dataPath, feedPath, "feed.xml"));
  const feed = (await feedFile.exists()) ? await feedFile.text() : null;

  if (feed) {
    const etag = config.devMode ? `"dev-${Date.now()}"` : `"${currentHash}-${feedPath}"`;
    const ifNoneMatch = req.headers.get("If-None-Match");

    if (!config.devMode && ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(feed, {
      headers: {
        "Content-Type": "application/atom+xml;charset=utf-8",
        ETag: etag,
        "Cache-Control": config.devMode ? "no-store" : "no-cache",
      },
    });
  }

  return new Response("Feed not found", { status: 404 });
}
