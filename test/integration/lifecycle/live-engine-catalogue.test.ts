import { test, expect } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../../src/context.ts";
import { createCatalogueHttpHandler } from "../../../src/catalogue-http.ts";
import { createLiveEngineLifecycle } from "../../../src/lifecycle/live-engine-lifecycle.ts";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import type { RawBooksEvent } from "../../../src/processing/types.ts";

const fixture = join(import.meta.dir, "../../../files/test/Test Book - Test Author.fb2");

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();

  return { promise, open: () => resolve() };
}

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "opds-live-engine-"));
  const sourcePath = join(root, "source");
  const outputPath = join(root, "output");
  await mkdir(sourcePath);
  const ctx = await buildContext();

  return {
    root,
    sourcePath,
    outputPath,
    deps: { ...ctx, config: { ...ctx.config, filesPath: sourcePath, dataPath: outputPath, reconcileInterval: 0 } },
  };
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;

  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Publication did not reach the expected observable state");
    await Bun.sleep(5);
  }
}

async function titles(outputPath: string) {
  return parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.title);
}

async function post(url: string, path: string, body?: RawBooksEvent) {
  const request: RequestInit = { method: "POST" };

  if (body !== undefined) request.body = JSON.stringify(body);
  const response = await fetch(`${url}${path}`, request);

  return { status: response.status, text: await response.text() };
}

test("HTTP watcher input publishes a real book without a manual resync", async () => {
  // #given an empty published catalogue and a real local control server
  const { root, sourcePath, outputPath, deps } = await tree();
  const runtime = createLiveEngineLifecycle(deps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });

  try {
    await runtime.start();
    await copyFile(fixture, join(sourcePath, "Book.fb2"));

    // #when only the existing watcher route receives a close-write notice
    const admission = await post(server.url.href.slice(0, -1), "/events/books", {
      parent: sourcePath,
      name: "Book.fb2",
      events: "CLOSE_WRITE",
    });

    await waitFor(async () => (await titles(outputPath)).includes("Test Book"));
    // #then the real fixture's metadata, browser link and acquisition target are published
    expect({
      admission,
      titles: await titles(outputPath),
      browserDownload: (await readFile(join(outputPath, "index.html"), "utf8")).includes('href="/Book.fb2/Book.fb2"'),
      downloadMatches: (await readFile(join(outputPath, "Book.fb2", "Book.fb2"))).equals(await readFile(fixture)),
    }).toEqual({ admission: { status: 202, text: "OK" }, titles: ["Test Book"], browserDownload: true, downloadMatches: true });
  } finally {
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP watcher input repairs an equal-stamp book replacement through its changed path hint", async () => {
  // #given a published book and its original source timestamp
  const { root, sourcePath, outputPath, deps } = await tree();
  const bookPath = join(sourcePath, "Book.fb2");
  const stableStamp = new Date("2020-01-01T00:00:00Z");
  await copyFile(fixture, bookPath);
  await utimes(bookPath, stableStamp, stableStamp);
  const runtime = createLiveEngineLifecycle(deps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });

  try {
    await runtime.start();
    const original = await readFile(bookPath, "utf8");
    await Bun.write(bookPath, original.replace("<book-title>Test Book</book-title>", "<book-title>Twin Book</book-title>"));
    await utimes(bookPath, stableStamp, stableStamp);

    // #when only the watcher route reports an equal-size, equal-mtime replacement
    const admission = await post(server.url.href.slice(0, -1), "/events/books", {
      parent: sourcePath,
      name: "Book.fb2",
      events: "CLOSE_WRITE",
    });

    await waitFor(async () => (await titles(outputPath)).includes("Twin Book"));
    // #then the changed path hint reaches freshness and republishes the new metadata
    expect({ admission, titles: await titles(outputPath) }).toEqual({ admission: { status: 202, text: "OK" }, titles: ["Twin Book"] });
  } finally {
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP resync while busy retains results and preserves forced follow-up after source replacement", async () => {
  // #given two real books and a held publication after extraction read the first replacement
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "First.fb2"));
  await copyFile(fixture, join(sourcePath, "Second.fb2"));
  const firstEntry = join(outputPath, "First.fb2", "entry.xml");
  const secondEntry = join(outputPath, "Second.fb2", "entry.xml");
  const entered = gate();
  const release = gate();
  let hold = false;

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      atomicWrite: async (path: string, content: string) => {
        if (hold && path === firstEntry) {
          hold = false;
          entered.open();
          await release.promise;
        }

        await deps.fs.atomicWrite(path, content);
      },
    },
  };

  const runtime = createLiveEngineLifecycle(heldDeps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
  const url = server.url.href.slice(0, -1);
  const ancient = new Date("2020-01-01T00:00:00Z");

  try {
    await runtime.start();
    const original = await readFile(fixture, "utf8");
    await utimes(secondEntry, ancient, ancient);
    await Bun.write(
      join(sourcePath, "First.fb2"),
      original.replace("<book-title>Test Book</book-title>", "<book-title>Changed Book</book-title>"),
    );
    hold = true;
    // #when ordinary processing is held and several real HTTP requests include forced mode
    const started = await post(url, "/resync");
    await entered.promise;
    const available = await titles(outputPath);
    const ordinaryLeftUnchangedBook = (await stat(secondEntry)).mtimeMs === ancient.getTime();
    const requests = [await post(url, "/resync"), await post(url, "/resync?force=1"), await post(url, "/resync")];
    await Bun.write(
      join(sourcePath, "First.fb2"),
      original.replace("<book-title>Test Book</book-title>", "<book-title>Current Book</book-title>"),
    );
    release.open();
    await waitFor(async () => (await runtime.status()).state === "complete");
    // #then old feeds stayed available and the forced follow-up publishes current bytes plus the unchanged book
    expect({
      started,
      available,
      ordinaryLeftUnchangedBook,
      requests,
      final: (await titles(outputPath)).sort(),
      forcedUnchangedBook: (await stat(secondEntry)).mtimeMs !== ancient.getTime(),
      browserAvailable: await Bun.file(join(outputPath, "index.html")).exists(),
      latestDownload: (await readFile(join(outputPath, "First.fb2", "First.fb2"), "utf8")).includes(
        "<book-title>Current Book</book-title>",
      ),
    }).toEqual({
      started: { status: 202, text: "Resync started" },
      available: ["Test Book", "Test Book"],
      ordinaryLeftUnchangedBook: true,
      requests: [
        { status: 202, text: "Resync queued" },
        { status: 202, text: "Resync queued" },
        { status: 202, text: "Resync queued" },
      ],
      final: ["Current Book", "Test Book"],
      forcedUnchangedBook: true,
      browserAvailable: true,
      latestDownload: true,
    });
  } finally {
    release.open();
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("periodic reconciliation repairs an unannounced detectable change in place", async () => {
  // #given a real book with prior published metadata and a held update boundary
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  const entered = gate();
  const release = gate();
  let hold = false;

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      atomicWrite: async (path: string, content: string) => {
        if (hold && path === join(outputPath, "Book.fb2", "entry.xml")) {
          hold = false;
          entered.open();
          await release.promise;
        }

        await deps.fs.atomicWrite(path, content);
      },
    },
  };

  const runtime = createLiveEngineLifecycle(heldDeps, { reconcileIntervalMs: 20 });

  try {
    await runtime.start();
    hold = true;
    const original = await readFile(fixture, "utf8");
    // #when source bytes change with no watcher notice or resync request
    await Bun.write(
      join(sourcePath, "Book.fb2"),
      original.replace("<book-title>Test Book</book-title>", "<book-title>Reconciled Book</book-title>"),
    );
    await entered.promise;
    const available = await titles(outputPath);
    release.open();
    await waitFor(async () => (await titles(outputPath)).includes("Reconciled Book"));
    // #then the timer's real handler work keeps prior output and repairs the catalogue
    expect({ available, final: await titles(outputPath) }).toEqual({ available: ["Test Book"], final: ["Reconciled Book"] });
  } finally {
    release.open();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a watcher-triggered update repairs a later source replacement without another notice", async () => {
  // #given an existing real book and a held entry publication after extraction
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  const entered = gate();
  const release = gate();
  let hold = false;

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      atomicWrite: async (path: string, content: string) => {
        if (hold && path === join(outputPath, "Book.fb2", "entry.xml")) {
          hold = false;
          entered.open();
          await release.promise;
        }

        await deps.fs.atomicWrite(path, content);
      },
    },
  };

  const runtime = createLiveEngineLifecycle(heldDeps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });

  try {
    await runtime.start();
    hold = true;
    const original = await readFile(fixture, "utf8");
    await Bun.write(
      join(sourcePath, "Book.fb2"),
      original.replace("<book-title>Test Book</book-title>", "<book-title>Earlier Book</book-title>"),
    );

    // #when one notice starts processing and the source changes again after the old metadata was extracted
    const admission = await post(server.url.href.slice(0, -1), "/events/books", {
      parent: sourcePath,
      name: "Book.fb2",
      events: "CLOSE_WRITE",
    });

    await entered.promise;
    const available = await titles(outputPath);
    await Bun.write(
      join(sourcePath, "Book.fb2"),
      original.replace("<book-title>Test Book</book-title>", "<book-title>Final Current Book</book-title>"),
    );
    release.open();
    await waitFor(async () => (await runtime.status()).state === "complete");
    // #then post-processing observation repairs the captured earlier result without another input
    expect({ admission, available, final: await titles(outputPath) }).toEqual({
      admission: { status: 202, text: "OK" },
      available: ["Test Book"],
      final: ["Final Current Book"],
    });
  } finally {
    release.open();
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
