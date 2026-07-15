import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
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

const readerDir = join(uiDir, "reader");
const foliateSourceDir = join(uiDir, "vendor", "foliate-js");

// The foliate runtime is copied as-is into the hashed asset dir (KTD-3's sanctioned
// fallback): bundling view.js would statically pull the pdf adapter and its 784 KB
// pdf.mjs into reader.js, defeating R13's lazy PDF loading. Copied unmodified, the
// runtime's own dynamic imports (epub.js, pdf.js → vendor/pdfjs/*) resolve relative
// to the dir and pdf.js bytes move only when a PDF actually opens. Demo/dev files and
// source maps (7 MB) stay out of the committed artifact.
const FOLIATE_EXCLUDED_FILES = new Set(["eslint.config.js", "rollup.config.js", "reader.js"]);
const FOLIATE_VENDOR_FILES = ["zip.js", "fflate.js"];
const FOLIATE_PDFJS_FILES = ["pdf.mjs", "pdf.worker.mjs", "text_layer_builder.css", "annotation_layer_builder.css"];
const FOLIATE_PDFJS_DIRS = ["cmaps", "standard_fonts"];

// pdf.js 5.5.207 calls Map.prototype.getOrInsertComputed on both the main thread and
// inside its worker (page-render path, not just metadata) — a builtin that only landed
// in Chrome/Edge 145, Firefox 144, Safari 18.4. Below that floor the PDF path throws.
// This spec-shaped shim is prepended to both bundles at build time (the submodule stays
// pristine; the patch lives only in the committed static/ copy) so PDFs render down-level
// too. It no-ops where the builtin exists natively. Prepended to pdf.worker.mjs as well
// because the worker's global scope does not inherit the main-thread prototype patch.
const PDFJS_COMPAT_SHIM = `(()=>{const p=Map.prototype;if(typeof p.getOrInsertComputed==="function")return;Object.defineProperty(p,"getOrInsertComputed",{value:function(key,callbackFunction){if(this.has(key))return this.get(key);const value=callbackFunction(key);this.set(key,value);return value;},writable:true,enumerable:false,configurable:true});})();\n`;
const FOLIATE_SHIMMED_FILES = new Set(["pdf.mjs", "pdf.worker.mjs"]);

async function foliateModuleFiles(): Promise<string[]> {
  const entries = await readdir(foliateSourceDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js") && !FOLIATE_EXCLUDED_FILES.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function copyFoliateRuntime(targetDir: string, moduleFiles: string[]): Promise<void> {
  await mkdir(join(targetDir, "vendor", "pdfjs"), { recursive: true });
  for (const file of moduleFiles) {
    await cp(join(foliateSourceDir, file), join(targetDir, file));
  }
  for (const file of FOLIATE_VENDOR_FILES) {
    await cp(join(foliateSourceDir, "vendor", file), join(targetDir, "vendor", file));
  }
  for (const file of FOLIATE_PDFJS_FILES) {
    const src = join(foliateSourceDir, "vendor", "pdfjs", file);
    const dest = join(targetDir, "vendor", "pdfjs", file);
    if (FOLIATE_SHIMMED_FILES.has(file)) {
      await Bun.write(dest, PDFJS_COMPAT_SHIM + (await Bun.file(src).text()));
    } else {
      await cp(src, dest);
    }
  }
  for (const dir of FOLIATE_PDFJS_DIRS) {
    await cp(join(foliateSourceDir, "vendor", "pdfjs", dir), join(targetDir, "vendor", "pdfjs", dir), { recursive: true });
  }
}

async function hashFoliateRuntime(moduleFiles: string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of moduleFiles) {
    hasher.update(await Bun.file(join(foliateSourceDir, file)).arrayBuffer());
  }
  for (const file of FOLIATE_VENDOR_FILES) {
    hasher.update(await Bun.file(join(foliateSourceDir, "vendor", file)).arrayBuffer());
  }
  for (const file of FOLIATE_PDFJS_FILES) {
    hasher.update(await Bun.file(join(foliateSourceDir, "vendor", "pdfjs", file)).arrayBuffer());
  }
  // Hash the copied CMap/font dirs too: nginx serves foliate-<hash> immutable for a year,
  // so a submodule bump touching only a .bcmap/.pfb must still change the URL (KTD-3 trap).
  for (const dir of FOLIATE_PDFJS_DIRS) {
    const dirPath = join(foliateSourceDir, "vendor", "pdfjs", dir);
    const entries = (await readdir(dirPath, { recursive: true })).sort();
    for (const entry of entries) {
      const full = join(dirPath, entry);
      if ((await stat(full)).isFile()) hasher.update(`${dir}/${entry}\n`).update(await Bun.file(full).arrayBuffer());
    }
  }
  // Fold the shim into the hash so changing it rebusts the immutable-cached dir name.
  hasher.update(PDFJS_COMPAT_SHIM);
  return hasher.digest("hex").slice(0, 12);
}

async function buildReader(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [join(readerDir, "reader.ts")],
    target: "browser",
    minify: true,
    naming: "reader.js",
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error("build:ui reader.js failed");
  }
  await Bun.write(join(staticDir, "reader.js"), await build.outputs[0]!.text());
  console.log(`build:ui → ${join(staticDir, "reader.js")}`);

  const moduleFiles = await foliateModuleFiles();
  const foliateDirName = `foliate-${await hashFoliateRuntime(moduleFiles)}`;
  const foliateDir = join(staticDir, foliateDirName);

  // Stale hash dirs must not linger: build:ui:check fails on untracked static/ files,
  // so an orphaned runtime directory would poison every later build. pdfjs- is the
  // dir's retired pre-release name, swept for the same reason.
  for (const entry of await readdir(staticDir)) {
    if (entry.startsWith("foliate-") || entry.startsWith("pdfjs-")) {
      await rm(join(staticDir, entry), { recursive: true });
    }
  }

  await copyFoliateRuntime(foliateDir, moduleFiles);
  console.log(`build:ui → ${foliateDir}`);

  // Lockstep (KTD-3): read.html and the hash regenerate in this one run, so the
  // immutable-cacheable dir can never be referenced by a stale page.
  const template = await Bun.file(join(readerDir, "read.html")).text();
  const css = await Bun.file(join(readerDir, "reader.css")).text();
  const readerCssResult = await postcss(pipeline).process(css, { from: undefined });
  const page = template.replace("__FOLIATE_BASE__", `/static/${foliateDirName}`).replace("__READER_CSS__", readerCssResult.css);
  await Bun.write(join(staticDir, "read.html"), page);
  console.log(`build:ui → ${join(staticDir, "read.html")}`);
}

await buildCss();
await buildJs();
await buildReader();
