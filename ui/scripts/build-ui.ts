import { join } from "node:path";
import postcss from "postcss";
import postcssRandomFunction from "@csstools/postcss-random-function";
import autoprefixer from "autoprefixer";
import postcssNesting from "postcss-nesting";
import cssnano from "cssnano";

const STYLE_SOURCES = ["reset.css", "index.css", "header.css", "variations.css"];

const uiDir = join(import.meta.dir, "..");
const stylesDir = join(uiDir, "styles");
const staticDir = join(uiDir, "..", "static");
const outPath = join(staticDir, "style.css");
const mainEntry = join(uiDir, "gridnav", "main.ts");

const pipeline = [
  postcssRandomFunction(),
  autoprefixer(),
  postcssNesting({ edition: "2021", noIsPseudoSelector: true }),
  cssnano({ preset: ["default", { discardComments: false }] }),
];

async function buildCss(): Promise<void> {
  let source = "";
  for (const file of STYLE_SOURCES) {
    source += (await Bun.file(join(stylesDir, file)).text()) + "\n";
  }

  // No formatter pass: the artifact stays cssnano-minified. A formatter here made
  // the build:ui:check freshness gate hostage to formatter version drift across machines.
  const result = await postcss(pipeline).process(source, { from: undefined });
  await Bun.write(outPath, result.css);
  console.log(`build:ui → ${outPath}`);
}

async function buildJs(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [mainEntry],
    target: "browser",
    minify: true,
    naming: "main.js",
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error("build:ui main.js failed");
  }
  await Bun.write(join(staticDir, "main.js"), await build.outputs[0]!.text());
  console.log(`build:ui → ${join(staticDir, "main.js")}`);
}

await buildCss();
await buildJs();
