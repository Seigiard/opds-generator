import { join } from "node:path";
import { $ } from "bun";

const renderDir = join(import.meta.dir, "..", "..", "src", "render");
const modules = ["feed-model.ts", "feed-xml.ts", "feed-html.ts", "parse-feed.ts"].map((f) => join(renderDir, f));

// Transitive purity: a browser-target build fails on any node builtin reached
// directly or through the dependency graph.
const build = await Bun.build({ entrypoints: modules, target: "browser" });
if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error("render:pure — src/render/* is not browser-importable (node builtin reached under target=browser)");
}

// Bun APIs are ambient globals, invisible to the bundler — the scoped
// no-restricted-globals rule in .oxlintrc.json catches them.
const lint = await $`oxlint --deny-warnings src/render/`.nothrow();
if (lint.exitCode !== 0) {
  throw new Error("render:pure — Bun global used in src/render/* (see oxlint output above)");
}

console.log(`render:pure → ${modules.length} render modules browser-importable, no Bun globals`);
