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
  // #given an empty output, a real book and a held book download link
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  const link = { entered: gate(), release: gate() };

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
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
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
  const url = server.url.href.slice(0, -1);

  try {
    const started = runtime.start();

    // #when the root feed is published while the book's download link stays held
    await link.entered.promise;

    const minimum = {
      facts: await facts(url),
      feed: await present(join(outputPath, "feed.xml")),
      generatedPage: await present(join(outputPath, "index.html")),
      bookEntry: await present(join(outputPath, "Book.fb2", "entry.xml")),
    };

    // #and the held book work finishes
    link.release.open();
    await started;
    const completed = await facts(url);

    // #then the root feed alone provides readiness, and completion is a separate fact
    expect({
      minimum,
      completed,
      titles: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.title),
    }).toEqual({
      minimum: {
        facts: { available: true, availableFrom: "minimum-publication", verifying: true, completed: false, errors: 0 },
        feed: true,
        generatedPage: false,
        bookEntry: false,
      },
      completed: { available: true, availableFrom: "minimum-publication", verifying: false, completed: true, errors: 0 },
      titles: ["Test Book"],
    });
  } finally {
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
  await rm(join(outputPath, "index.html"), { force: true });
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
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
  const url = server.url.href.slice(0, -1);

  try {
    // #when the second process is still verifying
    const started = runtime.start();
    await link.entered.promise;

    const verifying = {
      facts: await facts(url),
      feedKept: (await readFile(join(outputPath, "feed.xml"))).equals(priorFeed),
      generatedPage: await present(join(outputPath, "index.html")),
    };

    link.release.open();
    await started;
    const completed = await facts(url);

    // #then prior output is available throughout, and verification and completion are separate facts
    expect({ verifying, completed }).toEqual({
      verifying: {
        facts: { available: true, availableFrom: "prior-output", verifying: true, completed: false, errors: 0 },
        feedKept: true,
        generatedPage: false,
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

test("a cold start prunes a stale root index without delaying feed availability", async () => {
  // #given a stale generated page and a real book whose download publication is held
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(outputPath);
  await Bun.write(join(outputPath, "index.html"), "legacy browser page");
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  const link = { entered: gate(), release: gate() };

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
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
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
  const url = server.url.href.slice(0, -1);

  try {
    // #when the root feed is published and later book work is still held
    const started = runtime.start();
    await link.entered.promise;

    const observation = {
      facts: await facts(url),
      feed: await present(join(outputPath, "feed.xml")),
      generatedPage: await present(join(outputPath, "index.html")),
    };

    link.release.open();
    await started;

    // #then the old page is gone and the root feed is the available minimum
    expect(observation).toEqual({
      facts: { available: true, availableFrom: "minimum-publication", verifying: true, completed: false, errors: 0 },
      feed: true,
      generatedPage: false,
    });
  } finally {
    link.release.open();
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a damaged replacement converges while the independent book publishes", async () => {
  // #given a completed catalogue with two real books
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Damaged.fb2"));
  await copyFile(fixture, join(sourcePath, "Independent.fb2"));
  const runtime = createLiveEngineLifecycle(deps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
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

    while (!status.completed && Date.now() < deadline) {
      await Bun.sleep(20);
      status = await (await fetch(`${url}/status`)).json();
    }

    // #then completion converges, prior output stays, and independent work changed
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
      errors: [],
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
  await rm(join(outputPath, "index.html"), { force: true });
  const moved = join(root, "moved-source");
  await rename(sourcePath, moved);
  const fatal: unknown[] = [];
  const runtime = createLiveEngineLifecycle(deps, { onFatal: (cause) => fatal.push(cause) });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
  const url = server.url.href.slice(0, -1);

  try {
    // #when verification fails, the process stays up, and the source returns before a resync
    const startup = await runtime.start().then(
      () => "started",
      () => "rejected",
    );

    // #then the root feed alone was enough to enter recoverable prior-output mode
    expect(startup).toBe("started");
    const failed = await (await fetch(`${url}/status`)).json();

    const afterFailure = {
      available: failed.available,
      availableFrom: failed.availableFrom,
      verifying: failed.verifying,
      completed: failed.completed,
      errors: failed.errors.map((error: { source: string }) => error.source),
      fatal: fatal.length,
      feedKept: (await readFile(join(outputPath, "feed.xml"))).equals(priorFeed),
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
