import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import postcssRandomFunction from "@csstools/postcss-random-function";
import autoprefixer from "autoprefixer";
import postcssNesting from "postcss-nesting";

const repoRoot = resolve(import.meta.dirname, "..");
const foliateBase = `/@fs/${resolve(import.meta.dirname, "vendor", "foliate-js")}`;

// The reader smoke page (reader.html) loads the vendored foliate runtime straight from
// the submodule via Vite's fs allowlist; production serves the hashed static dir instead.
const injectFoliateBase = (): Plugin => ({
  name: "inject-foliate-base",
  transformIndexHtml: (html) => html.replace("__FOLIATE_BASE__", foliateBase),
});

export default defineConfig({
  root: resolve(import.meta.dirname, "playground"),
  plugins: [injectFoliateBase()],
  server: {
    fs: { allow: [repoRoot] },
  },
  css: {
    postcss: {
      plugins: [postcssRandomFunction(), autoprefixer(), postcssNesting({ edition: "2021", noIsPseudoSelector: true })],
    },
  },
});
