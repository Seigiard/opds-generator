import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFeed } from "../../src/render/parse-feed.ts";
import { browserHref, renderHtml } from "../../src/render/feed-html.ts";
import { breadcrumbsFor } from "../../src/render/breadcrumbs.ts";
import { renderShellState } from "../../src/render/shell-state.ts";

const feedsDir = join(import.meta.dir, "..", "..", "test", "fixtures", "feeds");

const goldenDir = join(import.meta.dir, "..", "..", "test", "golden");

// Clear existing goldens so a removed cassette surfaces as a git deletion, not a stale orphan render:check would pass over.
for (const name of await readdir(goldenDir)) {
  if (name.endsWith(".html")) await rm(join(goldenDir, name));
}

const feeds = (await readdir(feedsDir)).filter((name) => name.endsWith(".xml")).sort();

for (const name of feeds) {
  const xml = await Bun.file(join(feedsDir, name)).text();
  const model = parseFeed(xml);
  const html = renderHtml(model, breadcrumbsFor(browserHref(model.selfHref)));
  const outPath = join(goldenDir, basename(name, ".xml") + ".html");
  await Bun.write(outPath, html);
  console.log(`render:golden → ${outPath}`);
}

const stateCrumbs = breadcrumbsFor("/%D0%9A%D0%BD%D0%B8%D0%B3%D0%B8/%D0%9D%D0%B0%D1%83%D0%BA%D0%B0/");

const stateGoldens: Array<[string, Parameters<typeof renderShellState>[0]]> = [
  ["state-skeleton", { kind: "skeleton" }],
  ["state-starting", { kind: "starting", retryInSeconds: 5 }],
  ["state-not-found", { kind: "not-found" }],
  ["state-error-status", { kind: "http-error", status: 500 }],
  ["state-error-message", { kind: "error", message: "Network offline" }],
];

for (const [name, state] of stateGoldens) {
  const outPath = join(goldenDir, `${name}.html`);
  await Bun.write(outPath, renderShellState(state, stateCrumbs));
  console.log(`render:golden → ${outPath}`);
}
