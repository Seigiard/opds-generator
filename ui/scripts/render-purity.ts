import { builtinModules } from "node:module";
import { join, relative, resolve } from "node:path";
import { $, Glob } from "bun";
import * as v from "valibot";

const repoRoot = join(import.meta.dir, "..", "..");

// Every browser bundle: the renderer modules, plus the gridnav and reader
// shells that build:ui ships as main.js and reader.js.
const entrypoints = [
  "src/render/feed-model.ts",
  "src/render/feed-xml.ts",
  "src/render/feed-html.ts",
  "src/render/parse-feed.ts",
  "ui/gridnav/parse-feed-dom.ts",
  "ui/gridnav/main.ts",
  "ui/reader/reader.ts",
].map((path) => join(repoRoot, path));

const browserRule = "no-restricted-globals";

const builtins = new Set(builtinModules);

// bun-types 1.3.5 does not declare the metafile that Bun.build returns at runtime,
// so the gate parses it instead of trusting a declared type.
const metafileSchema = v.object({
  metafile: v.object({
    inputs: v.record(v.string(), v.object({ imports: v.array(v.object({ path: v.string(), external: v.optional(v.boolean()) })) })),
  }),
});

const oxlintConfigSchema = v.object({
  overrides: v.array(v.object({ files: v.array(v.string()), rules: v.optional(v.object({ [browserRule]: v.optional(v.unknown()) })) })),
});

// A variable, not a literal: bun-types 1.3.5 rejects the metafile option as an excess property.
const buildConfig = { entrypoints, target: "browser" as const, throw: false, metafile: true };

const build = await Bun.build(buildConfig);

if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error("render:pure — browser bundle failed to build");
}

const inputs = Object.entries(v.parse(metafileSchema, build).metafile.inputs);

// A browser-target build does not fail on a node or Bun builtin: Bun replaces it
// with an empty object and marks the import external, so the gate reads the marks.
const stubbed = inputs.flatMap(([importer, { imports }]) =>
  imports.filter((imp) => imp.external === true && isRuntimeBuiltin(imp.path)).map((imp) => `${projectPath(importer)} → ${imp.path}`),
);

if (stubbed.length > 0) {
  for (const line of stubbed) console.error(`  ${line}`);
  throw new Error("render:pure — a node or Bun builtin reaches a browser bundle (stubbed to an empty object under target=browser)");
}

const ownModules = inputs
  .map(([input]) => projectPath(input))
  .filter((path) => path.endsWith(".ts") && !path.startsWith("..") && !path.startsWith("node_modules/") && !path.startsWith("ui/vendor/"))
  .sort();

// Bun APIs are ambient globals, invisible to the bundler. The browser override in
// .oxlintrc.json catches them, so every module in the graph must match its globs.
const browserGlobs = await readBrowserGlobs();

const uncovered = ownModules.filter((path) => !browserGlobs.some((glob) => glob.match(path)));

if (uncovered.length > 0) {
  for (const path of uncovered) console.error(`  ${path}`);
  throw new Error(`render:pure — browser bundle modules outside the ${browserRule} override in .oxlintrc.json; add them to its "files"`);
}

const lint = await $`oxlint --deny-warnings ${ownModules}`.cwd(repoRoot).nothrow();

if (lint.exitCode !== 0) {
  throw new Error("render:pure — Bun global or runtime import in a browser bundle module (see oxlint output above)");
}

console.log(`render:pure → ${ownModules.length} browser bundle modules: no node or Bun builtins, all under the oxlint browser override`);

function isRuntimeBuiltin(path: string): boolean {
  return path.startsWith("node:") || path === "bun" || path.startsWith("bun:") || builtins.has(path);
}

function projectPath(input: string): string {
  return relative(repoRoot, resolve(process.cwd(), input));
}

async function readBrowserGlobs(): Promise<Glob[]> {
  const oxlintConfig = v.parse(oxlintConfigSchema, await Bun.file(join(repoRoot, ".oxlintrc.json")).json());
  const override = oxlintConfig.overrides.find((entry) => entry.rules?.[browserRule] !== undefined);

  if (!override) {
    throw new Error(`render:pure — .oxlintrc.json has no override with ${browserRule}`);
  }

  return override.files.map((pattern) => new Glob(pattern));
}
