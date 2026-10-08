import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../../src/context.ts";
import { createCatalogueHttpHandler } from "../../../src/catalogue-http.ts";
import { createLiveEngineLifecycle } from "../../../src/lifecycle/live-engine-lifecycle.ts";
import { parseFeed } from "../../../src/render/parse-feed.ts";

const fixture = join(import.meta.dir, "../../../files/test/Test Book - Test Author.fb2");

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();

  return { promise, open: () => resolve() };
}

const present = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "opds-readiness-"));
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

/** The public facts, read through the same Bun-local route that the container exposes. */
async function facts(url: string) {
  const body = await (await fetch(`${url}/status`)).json();
  const { available, availableFrom, verifying, completed, errors } = body;

  return { available, availableFrom, verifying, completed, errors: errors?.length };
}

test("a cold start reports availability at the root minimum while held book work is still pending", async () => {
  // #given an empty output, a real book, a held root browser page and a held book download link
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  const rootPage = { entered: gate(), release: gate(), held: true };
  const link = { entered: gate(), release: gate() };

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      atomicWrite: async (path: string, content: string) => {
        if (rootPage.held && path === join(outputPath, "index.html")) {
          rootPage.held = false;
          rootPage.entered.open();
          await rootPage.release.promise;
        }

        await deps.fs.atomicWrite(path, content);
      },
      symlink: async (target: string, path: string) => {
        if (path === join(outputPath, "Book.fb2", "Book.fb2")) {
          link.entered.open();
          await link.release.promise;
        }

        await deps.fs.symlink(target, path);
      },
    },
  };

  const runtime = createLiveEngineLifecycle(heldDeps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime, { shouldProcess: () => true }) });
  const url = server.url.href.slice(0, -1);

  try {
    const started = runtime.start();

    // #when the root feed exists but its browser page is still held
    await rootPage.entered.promise;

    const feedOnly = {
      facts: await facts(url),
      feed: await present(join(outputPath, "feed.xml")),
      page: await present(join(outputPath, "index.html")),
    };

    // #and the page is released while the book's download link stays held
    rootPage.release.open();
    await link.entered.promise;

    const minimum = {
      facts: await facts(url),
      feed: await present(join(outputPath, "feed.xml")),
      page: await present(join(outputPath, "index.html")),
      bookEntry: await present(join(outputPath, "Book.fb2", "entry.xml")),
    };

    // #and the held book work finishes
    link.release.open();
    await started;
    const completed = await facts(url);

    // #then readiness needs both root files, ignores pending book work, and completion is a separate fact
    expect({
      feedOnly,
      minimum,
      completed,
      titles: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.title),
    }).toEqual({
      feedOnly: { facts: { available: false, availableFrom: null, verifying: true, completed: false, errors: 0 }, feed: true, page: false },
      minimum: {
        facts: { available: true, availableFrom: "minimum-publication", verifying: true, completed: false, errors: 0 },
        feed: true,
        page: true,
        bookEntry: false,
      },
      completed: { available: true, availableFrom: "minimum-publication", verifying: false, completed: true, errors: 0 },
      titles: ["Test Book"],
    });
  } finally {
    rootPage.release.open();
    link.release.open();
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a warm start reports prior output while a held verification is active, then reports completion", async () => {
  // #given a published catalogue of a real book, stopped, and a changed source mtime that forces verification
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  const first = createLiveEngineLifecycle(deps);
  await first.start();
  await first.stop();
  const priorFeed = await readFile(join(outputPath, "feed.xml"));
  const priorPage = await readFile(join(outputPath, "index.html"));
  await utimes(join(sourcePath, "Book.fb2"), new Date(), new Date("2031-01-01T00:00:00Z"));
  const link = { entered: gate(), release: gate() };

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      symlink: async (target: string, path: string) => {
        link.entered.open();
        await link.release.promise;
        await deps.fs.symlink(target, path);
      },
    },
  };

  const runtime = createLiveEngineLifecycle(heldDeps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime, { shouldProcess: () => true }) });
  const url = server.url.href.slice(0, -1);

  try {
    // #when the second process is still verifying
    const started = runtime.start();
    await link.entered.promise;

    const verifying = {
      facts: await facts(url),
      feedKept: (await readFile(join(outputPath, "feed.xml"))).equals(priorFeed),
      pageKept: (await readFile(join(outputPath, "index.html"))).equals(priorPage),
    };

    link.release.open();
    await started;
    const completed = await facts(url);

    // #then prior output is available throughout, and verification and completion are separate facts
    expect({ verifying, completed }).toEqual({
      verifying: {
        facts: { available: true, availableFrom: "prior-output", verifying: true, completed: false, errors: 0 },
        feedKept: true,
        pageKept: true,
      },
      completed: { available: true, availableFrom: "prior-output", verifying: false, completed: true, errors: 0 },
    });
  } finally {
    link.release.open();
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a cold start whose root page cannot be published never becomes available and fails the startup", async () => {
  // #given an empty output and a root browser page that cannot be written
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  const fatal: unknown[] = [];

  const failingDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      atomicWrite: async (path: string, content: string) => {
        if (path === join(outputPath, "index.html")) throw new Error("Root page denied");
        await deps.fs.atomicWrite(path, content);
      },
    },
  };

  const runtime = createLiveEngineLifecycle(failingDeps, { onFatal: (cause) => fatal.push(cause) });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime, { shouldProcess: () => true }) });

  try {
    // #when the first pass runs
    const outcome = await runtime.start().then(
      () => "started",
      (cause: unknown) => String(cause),
    );

    const status = await (await fetch(`${server.url.href}status`)).json();

    // #then startup rejected, no readiness was ever reported and the remaining book was not published
    expect({
      rejectedWithRootFailure: outcome.includes("Root page denied"),
      fatal: fatal.length,
      available: status.available,
      verifying: status.verifying,
      completed: status.completed,
      errors: status.errors.map((error: { source: string }) => error.source),
      bookPublished: await present(join(outputPath, "Book.fb2", "entry.xml")),
    }).toEqual({
      rejectedWithRootFailure: true,
      fatal: 1,
      available: false,
      verifying: false,
      completed: false,
      errors: ["pass"],
      bookPublished: false,
    });
  } finally {
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a damaged replacement is a retained error after completion while the independent book publishes", async () => {
  // #given a completed catalogue with two real books
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Damaged.fb2"));
  await copyFile(fixture, join(sourcePath, "Independent.fb2"));
  const runtime = createLiveEngineLifecycle(deps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime, { shouldProcess: () => true }) });
  const url = server.url.href.slice(0, -1);

  try {
    await runtime.start();
    const previousEntry = await readFile(join(outputPath, "Damaged.fb2", "entry.xml"));
    // #when one source becomes unreadable and another changes, then a forced pass drains
    await Bun.write(join(sourcePath, "Damaged.fb2"), "not a FictionBook");
    await Bun.write(
      join(sourcePath, "Independent.fb2"),
      (await readFile(fixture, "utf8")).replace("<book-title>Test Book</book-title>", "<book-title>Changed Book</book-title>"),
    );
    await fetch(`${url}/resync?force=1`, { method: "POST" });
    const deadline = Date.now() + 5000;
    let status = await (await fetch(`${url}/status`)).json();

    while (!(status.completed && status.errors.length > 0) && Date.now() < deadline) {
      await Bun.sleep(20);
      status = await (await fetch(`${url}/status`)).json();
    }

    // #then the error is public after completion, prior output stays, and independent work changed
    expect({
      available: status.available,
      verifying: status.verifying,
      completed: status.completed,
      errors: status.errors.map((error: { source: string; message: string }) => error.source),
      entryRetained: (await readFile(join(outputPath, "Damaged.fb2", "entry.xml"))).equals(previousEntry),
      titles: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8"))
        .entries.map((entry) => entry.title)
        .sort(),
    }).toEqual({
      available: true,
      verifying: false,
      completed: true,
      errors: ["work"],
      entryRetained: true,
      titles: ["Changed Book", "Test Book"],
    });
  } finally {
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a warm start whose source cannot be read keeps the prior catalogue available and retries on resync", async () => {
  // #given a published real catalogue and a source root that is gone when the next process starts
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  const first = createLiveEngineLifecycle(deps);
  await first.start();
  await first.stop();
  const priorFeed = await readFile(join(outputPath, "feed.xml"));
  const priorPage = await readFile(join(outputPath, "index.html"));
  const moved = join(root, "moved-source");
  await rename(sourcePath, moved);
  const fatal: unknown[] = [];
  const runtime = createLiveEngineLifecycle(deps, { onFatal: (cause) => fatal.push(cause) });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime, { shouldProcess: () => true }) });
  const url = server.url.href.slice(0, -1);

  try {
    // #when verification fails, the process stays up, and the source returns before a resync
    await runtime.start();
    const failed = await (await fetch(`${url}/status`)).json();

    const afterFailure = {
      available: failed.available,
      availableFrom: failed.availableFrom,
      verifying: failed.verifying,
      completed: failed.completed,
      errors: failed.errors.map((error: { source: string }) => error.source),
      fatal: fatal.length,
      feedKept: (await readFile(join(outputPath, "feed.xml"))).equals(priorFeed),
      pageKept: (await readFile(join(outputPath, "index.html"))).equals(priorPage),
    };

    await rename(moved, sourcePath);
    const resync = await fetch(`${url}/resync`, { method: "POST" });
    const deadline = Date.now() + 5000;
    let retried = await facts(url);

    while (!retried.completed && Date.now() < deadline) {
      await Bun.sleep(20);
      retried = await facts(url);
    }

    // #then the failure was observable without being fatal, and the retry completed without a restart
    expect({ afterFailure, resync: resync.status, retried }).toEqual({
      afterFailure: {
        available: true,
        availableFrom: "prior-output",
        verifying: false,
        completed: false,
        errors: ["pass"],
        fatal: 0,
        feedKept: true,
        pageKept: true,
      },
      resync: 202,
      retried: { available: true, availableFrom: "prior-output", verifying: false, completed: true, errors: 0 },
    });
  } finally {
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
