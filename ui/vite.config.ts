import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import autoprefixer from "autoprefixer";
import postcssNesting from "postcss-nesting";

const repoRoot = resolve(import.meta.dirname, "..");

const gridnavDir = resolve(import.meta.dirname, "gridnav");

const shellPath = join(gridnavDir, "index.html");

const mainPath = join(gridnavDir, "main.ts");

const stylesDir = resolve(import.meta.dirname, "styles");

const styleSources = ["reset.css", "index.css", "header.css", "lqip.css"];

const feedsDir = resolve(repoRoot, "test", "fixtures", "feeds");

const fixtureAliases = new Map([
  ["comics", "deep-nested.xml"],
  ["nonfiction", "nonfiction-cyrillic.xml"],
  ["pdf", "cyrillic-book.xml"],
  ["test", "large-folder.xml"],
]);

const foliateBase = `/@fs/${resolve(import.meta.dirname, "vendor", "foliate-js")}`;

// The reader smoke page (reader.html) loads the vendored foliate runtime straight from
// the submodule via Vite's fs allowlist; production serves the hashed static dir instead.
const injectFoliateBase = (): Plugin => ({
  name: "inject-foliate-base",
  transformIndexHtml: (html) => html.replace("__FOLIATE_BASE__", foliateBase),
});

const send = (response: ServerResponse, status: number, type: string, body: string | Uint8Array): void => {
  response.statusCode = status;
  response.setHeader("Content-Type", type);
  response.end(body);
};

const browserShell = (): Plugin => ({
  name: "browser-shell",
  async configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

      if (pathname.startsWith("/_catalog/") && pathname.endsWith("/feed.xml")) {
        const folder = pathname.slice("/_catalog/".length, -"/feed.xml".length).split("/").filter(Boolean)[0];
        const fixture = folder ? `${folder}.xml` : "root.xml";
        const fixturePath = join(feedsDir, fixture);
        const fallbackFixture = folder ? fixtureAliases.get(folder) : undefined;
        const fallbackPath = fallbackFixture ? join(feedsDir, fallbackFixture) : undefined;

        try {
          const xml = await readFile(fixturePath, "utf8");
          send(response, 200, "application/xml; charset=utf-8", xml);
        } catch {
          if (!fallbackPath) {
            next();

            return;
          }

          try {
            const xml = await readFile(fallbackPath, "utf8");
            send(response, 200, "application/xml; charset=utf-8", xml);
          } catch {
            next();
          }
        }

        return;
      }

      if (pathname === "/_app/main.js") {
        const result = await server.transformRequest(mainPath);

        if (!result) {
          next();

          return;
        }

        send(response, 200, "application/javascript; charset=utf-8", result.code);

        return;
      }

      if (pathname === "/_app/style.css") {
        const css = await Promise.all(styleSources.map((source) => readFile(join(stylesDir, source), "utf8")));
        send(response, 200, "text/css; charset=utf-8", css.join("\n"));

        return;
      }

      if (pathname.startsWith("/_app/favicon/")) {
        const name = pathname.slice("/_app/favicon/".length);

        try {
          const file = await readFile(join(repoRoot, "static", "favicon", name));
          send(response, 200, "application/octet-stream", file);
        } catch {
          next();
        }

        return;
      }

      const isFolderPath = pathname === "/" || pathname === "/index.html" || (pathname.endsWith("/") && !pathname.startsWith("/reader"));

      if (isFolderPath) {
        send(response, 200, "text/html; charset=utf-8", await readFile(shellPath, "utf8"));

        return;
      }

      next();
    });
  },
});

export default defineConfig({
  root: resolve(import.meta.dirname, "playground"),
  plugins: [injectFoliateBase(), browserShell()],
  server: {
    fs: { allow: [repoRoot] },
  },
  css: {
    postcss: {
      plugins: [autoprefixer(), postcssNesting({ edition: "2021", noIsPseudoSelector: true })],
    },
  },
});
