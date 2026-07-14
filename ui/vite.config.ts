import { resolve } from "node:path";
import { defineConfig } from "vite";
import postcssRandomFunction from "@csstools/postcss-random-function";
import autoprefixer from "autoprefixer";
import postcssNesting from "postcss-nesting";

const repoRoot = resolve(import.meta.dirname, "..");

export default defineConfig({
  root: resolve(import.meta.dirname, "playground"),
  server: {
    fs: { allow: [repoRoot] },
  },
  css: {
    postcss: {
      plugins: [postcssRandomFunction(), autoprefixer(), postcssNesting({ edition: "2021", noIsPseudoSelector: true })],
    },
  },
});
