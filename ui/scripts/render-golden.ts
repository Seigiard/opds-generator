import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFeed } from "../../src/render/parse-feed.ts";
import { renderHtml } from "../../src/render/feed-html.ts";

const feedsDir = join(import.meta.dir, "..", "..", "test", "fixtures", "feeds");
const goldenDir = join(import.meta.dir, "..", "..", "test", "golden");

// Clear existing goldens so a removed cassette surfaces as a git deletion, not a stale orphan render:check would pass over.
for (const name of await readdir(goldenDir)) {
  if (name.endsWith(".html")) await rm(join(goldenDir, name));
}

const feeds = (await readdir(feedsDir)).filter((name) => name.endsWith(".xml")).sort();

for (const name of feeds) {
  const xml = await Bun.file(join(feedsDir, name)).text();
  const html = renderHtml(parseFeed(xml));
  const outPath = join(goldenDir, basename(name, ".xml") + ".html");
  await Bun.write(outPath, html);
  console.log(`render:golden → ${outPath}`);
}
