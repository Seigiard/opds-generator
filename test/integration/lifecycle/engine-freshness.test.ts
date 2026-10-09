import { test, expect } from "bun:test";
import { Effect, Exit } from "effect";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogueHttpHandler } from "../../../src/catalogue-http.ts";
import { buildContext } from "../../../src/context.ts";
import { engineOptions, initialEngineCatalogue, openEngineCatalogue } from "../../../src/lifecycle/initial-engine-catalogue.ts";
import { createLiveEngineLifecycle } from "../../../src/lifecycle/live-engine-lifecycle.ts";
import { openLiveEngineCatalogue } from "../../../src/lifecycle/live-engine-catalogue.ts";
import { CatalogueDeps, CatalogueEvent } from "../../../src/processing/effect-handler.ts";
import { EffectFileSystem, effectFileSystemFromPromiseService } from "../../../src/effect-file-system.ts";
import type { LogContext } from "../../../src/logging/types.ts";
import { PROCESSING_VERSIONS } from "../../../src/processing-versions.ts";
import { runInitialPass as runReleasedEngine040 } from "@seigiard/sync-engine-0-4";
import { runInitialPass as runPreviousEngine } from "@seigiard/sync-engine-previous";
import { runInitialPass as runCurrentEngine } from "@seigiard/sync-engine";
import { parseFeed } from "../../../src/render/parse-feed.ts";

const ancient = new Date("2020-01-01T00:00:00Z");

const fixture = join(import.meta.dir, "../../../files/test/Test Book - Test Author.fb2");

const safePromise = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Error(String(cause)) }).pipe(Effect.uninterruptible);

async function facts(url: string) {
  const body = await (await fetch(`${url}/status`)).json();
  const { available, availableFrom, verifying, completed, errors } = body;

  return { available, availableFrom, verifying, completed, errors: errors?.length };
}

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "opds-engine-freshness-"));
  const sourcePath = join(root, "source");
  const outputPath = join(root, "output");
  await mkdir(join(sourcePath, "Fiction"), { recursive: true });
  await copyFile(fixture, join(sourcePath, "Fiction", "Book.fb2"));
  const ctx = await buildContext();

  return {
    root,
    sourcePath,
    outputPath,
    deps: { ...ctx, config: { ...ctx.config, filesPath: sourcePath, dataPath: outputPath, reconcileInterval: 0 } },
  };
}

function nextVersion(version: string): string {
  return `${version}-next`;
}

test("a released engine package update alone keeps OPDS publications fresh", async () => {
  // #given OPDS output and freshness state created by the released 0.4.0 package
  const { root, outputPath, deps } = await tree();
  const artifacts = ["Fiction/Book.fb2/entry.xml", "Fiction/feed.xml", "Fiction/index.html", "feed.xml", "index.html"];
  const completedHandlers: string[] = [];

  const countedDeps = {
    ...deps,
    logger: {
      ...deps.logger,
      info: (component: string, message: string, fields?: LogContext) => {
        if (message === "Handler completed") completedHandlers.push(String(fields?.event_tag));
        deps.logger.info(component, message, fields);
      },
    },
  };

  try {
    await Effect.runPromise(
      runReleasedEngine040(engineOptions(deps, { processingVersions: PROCESSING_VERSIONS })).pipe(
        Effect.provideService(CatalogueDeps, deps),
        Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
      ),
    );

    for (const path of artifacts) await utimes(join(outputPath, path), ancient, ancient);

    const runtime = createLiveEngineLifecycle(countedDeps);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
    const url = server.url.href.slice(0, -1);

    try {
      // #when the current released package verifies the same DATA tree through the production lifecycle
      await runtime.start();

      // #then public status completes and unchanged reader-visible outputs are not reprocessed
      expect({
        status: await facts(url),
        mtimes: await Promise.all(artifacts.map(async (path) => (await stat(join(outputPath, path))).mtimeMs)),
        completedHandlers,
        titles: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((entry) => entry.title),
      }).toEqual({
        status: { available: true, availableFrom: "prior-output", verifying: false, completed: true, errors: 0 },
        mtimes: artifacts.map(() => ancient.getTime()),
        completedHandlers: [],
        titles: ["Test Book"],
      });
    } finally {
      await runtime.stop();
      server.stop(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh packaged engine instance reuses real book and folder publications", async () => {
  // #given the existing independent FB2 fixture and deliberately dated successful artifacts
  const { root, outputPath, deps } = await tree();
  const artifacts = ["Fiction/Book.fb2/entry.xml", "Fiction/feed.xml", "Fiction/index.html", "feed.xml", "index.html"];

  try {
    await Effect.runPromise(initialEngineCatalogue(deps));

    for (const path of artifacts) await utimes(join(outputPath, path), ancient, ancient);
    // #when a new scoped instance checks the same real source tree
    await Effect.runPromise(initialEngineCatalogue(deps));
    // #then reader-visible results remain correct without being rewritten
    expect({
      mtimes: await Promise.all(artifacts.map(async (path) => (await stat(join(outputPath, path))).mtimeMs)),
      titles: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((entry) => entry.title),
      downloadMatchesFixture: (await readFile(join(outputPath, "Fiction", "Book.fb2", "Book.fb2"))).equals(await readFile(fixture)),
    }).toEqual({ mtimes: artifacts.map(() => ancient.getTime()), titles: ["Test Book"], downloadMatchesFixture: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the application default processing versions rebuild results from an older release", async () => {
  // #given old application processing versions and independently dated published artifacts
  const { root, outputPath, deps } = await tree();
  const artifacts = ["Fiction/Book.fb2/entry.xml", "Fiction/feed.xml", "Fiction/index.html", "feed.xml", "index.html"];
  const completedHandlers: string[] = [];

  const countedDeps = {
    ...deps,
    logger: {
      ...deps.logger,
      info: (component: string, message: string, fields?: LogContext) => {
        if (message === "Handler completed") completedHandlers.push(String(fields?.event_tag));
        deps.logger.info(component, message, fields);
      },
    },
  };

  try {
    await Effect.runPromise(initialEngineCatalogue(deps, { processingVersions: { book: "0", folder: "0" } }));

    for (const path of artifacts) await utimes(join(outputPath, path), ancient, ancient);

    const runtime = createLiveEngineLifecycle(countedDeps);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
    const url = server.url.href.slice(0, -1);

    try {
      // #when production verifies the same tree with the current app-owned default versions
      await runtime.start();

      // #then stale release outputs are rebuilt without a force resync or source change
      expect({
        status: await facts(url),
        completedHandlers: completedHandlers.length > 0,
        rewritten: await Promise.all(artifacts.map(async (path) => (await stat(join(outputPath, path))).mtimeMs !== ancient.getTime())),
        titles: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((entry) => entry.title),
      }).toEqual({
        status: { available: true, availableFrom: "prior-output", verifying: false, completed: true, errors: 0 },
        completedHandlers: true,
        rewritten: [true, true, true, true, true],
        titles: ["Test Book"],
      });
    } finally {
      await runtime.stop();
      server.stop(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an independently packed engine package upgrade alone preserves existing successful publications", async () => {
  // #given actual real-handler success recorded by the earlier installed package
  const { root, outputPath, deps } = await tree();
  const artifacts = ["Fiction/Book.fb2/entry.xml", "Fiction/feed.xml", "Fiction/index.html", "feed.xml", "index.html"];
  // Keep the generic external-state configuration stable across package versions.
  const configuration = { ...engineOptions(deps), statePath: undefined };

  try {
    await Effect.runPromise(
      runPreviousEngine(configuration).pipe(
        Effect.provideService(CatalogueDeps, deps),
        Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
      ),
    );

    for (const path of artifacts) await utimes(join(outputPath, path), ancient, ancient);
    // #when the current separately packed engine checks the same application versions
    await Effect.runPromise(
      runCurrentEngine(configuration).pipe(
        Effect.provideService(CatalogueDeps, deps),
        Effect.provideService(EffectFileSystem, effectFileSystemFromPromiseService(deps.fs)),
      ),
    );
    // #then unchanged actual publications retain their independent timestamps and known metadata
    expect({
      mtimes: await Promise.all(artifacts.map(async (path) => (await stat(join(outputPath, path))).mtimeMs)),
      titles: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((entry) => entry.title),
    }).toEqual({ mtimes: artifacts.map(() => ancient.getTime()), titles: ["Test Book"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["default-limit", "hint", "content"])("%s behavior for a real equal-stamp FB2 replacement", async (mode) => {
  // #given known fixture metadata saved with an exact source stamp
  const { root, sourcePath, outputPath, deps } = await tree();
  const source = join(sourcePath, "Fiction", "Book.fb2");
  const book = join(outputPath, "Fiction", "Book.fb2", "entry.xml");
  const options = { check: mode === "content" ? ("content" as const) : ("metadata" as const) };
  await utimes(source, ancient, ancient);

  try {
    await Effect.runPromise(initialEngineCatalogue(deps, options));
    await utimes(book, ancient, ancient);
    const before = await stat(source);

    // #when actual content changes with both size and mtime restored
    const replacement = (await readFile(fixture, "utf8")).replace(
      "<book-title>Test Book</book-title>",
      "<book-title>Next Book</book-title>",
    );

    await Bun.write(source, replacement);
    await utimes(source, ancient, ancient);
    await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(deps, options).pipe(
          Effect.flatMap((session) =>
            mode === "hint"
              ? session
                  .submit([CatalogueEvent.BookCreated({ parent: join(sourcePath, "Fiction"), name: "Book.fb2" })], {
                    changedPaths: ["Fiction/Book.fb2"],
                  })
                  .pipe(Effect.andThen(session.awaitCompletion))
              : Effect.void,
          ),
        ),
      ),
    );
    const after = await stat(source);
    // #then selected detection, actual processing and its required leaf publication agree
    expect({
      sameSize: before.size === after.size,
      sameMtime: before.mtimeMs === after.mtimeMs,
      titles: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((entry) => entry.title),
      rebuilt: (await stat(book)).mtimeMs !== ancient.getTime(),
      download: (await readFile(join(outputPath, "Fiction", "Book.fb2", "Book.fb2"), "utf8")) === replacement,
    }).toEqual({
      sameSize: true,
      sameMtime: true,
      titles: [mode === "default-limit" ? "Test Book" : "Next Book"],
      rebuilt: mode !== "default-limit",
      download: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed real book publication retains its old entry and is replayed by a fresh instance", async () => {
  // #given a successful real catalogue and a failed replacement entry-write boundary
  const { root, sourcePath, outputPath, deps } = await tree();
  const source = join(sourcePath, "Fiction", "Book.fb2");
  const entry = join(outputPath, "Fiction", "Book.fb2", "entry.xml");
  await utimes(source, ancient, ancient);
  const versions = { processingVersions: { book: nextVersion(PROCESSING_VERSIONS.book) } };

  try {
    await Effect.runPromise(initialEngineCatalogue(deps));
    await utimes(entry, ancient, ancient);

    const failingDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        atomicWrite: async (path: string, content: string) => {
          if (path === entry) throw new Error("Entry write unavailable");
          await deps.fs.atomicWrite(path, content);
        },
      },
    };

    // #when processing fails after a same-stamp source replacement, then a new instance retries
    await Bun.write(
      source,
      (await readFile(fixture, "utf8")).replace("<book-title>Test Book</book-title>", "<book-title>Next Book</book-title>"),
    );
    await utimes(source, ancient, ancient);
    const failure = await Effect.runPromiseExit(initialEngineCatalogue(failingDeps, versions));
    const retained = parseFeed(`<feed>${await readFile(entry, "utf8")}</feed>`).entries.map((item) => item.title);
    const oldMtime = (await stat(entry)).mtimeMs;
    await Effect.runPromise(initialEngineCatalogue(deps, versions));
    // #then last success survives failure and repair reaches the actual acquisition catalogue
    expect({
      failure: Exit.isFailure(failure),
      retained,
      oldMtime,
      repaired: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((item) => item.title),
    }).toEqual({ failure: true, retained: ["Test Book"], oldMtime: ancient.getTime(), repaired: ["Next Book"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted real book preparation is not considered current by a fresh instance", async () => {
  // #given a prior real publication and preparation held at the source stat boundary
  const { root, sourcePath, outputPath, deps } = await tree();
  const source = join(sourcePath, "Fiction", "Book.fb2");
  const entry = join(outputPath, "Fiction", "Book.fb2", "entry.xml");
  const controller = new AbortController();
  let entered = () => {};

  let release = () => {};

  const atStat = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const versions = { processingVersions: { book: nextVersion(PROCESSING_VERSIONS.book) } };

  try {
    await Effect.runPromise(initialEngineCatalogue(deps));
    await utimes(entry, ancient, ancient);
    await Bun.write(
      source,
      (await readFile(fixture, "utf8")).replace("<book-title>Test Book</book-title>", "<book-title>Next Book</book-title>"),
    );

    const heldDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        stat: async (path: string) => {
          if (path === source) {
            entered();
            await released;
          }

          return deps.fs.stat(path);
        },
      },
    };

    // #when owned preparation is interrupted and then allowed to settle
    const running = Effect.runPromiseExit(initialEngineCatalogue(heldDeps, versions), { signal: controller.signal });
    await atStat;
    controller.abort();
    release();
    const exit = await running;
    const retained = parseFeed(`<feed>${await readFile(entry, "utf8")}</feed>`).entries.map((item) => item.title);
    await Effect.runPromise(initialEngineCatalogue(deps, versions));
    // #then interrupted work leaves the prior entry and the next engine performs the repair
    expect({
      interrupted: Exit.isFailure(exit),
      retained,
      repaired: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((item) => item.title),
    }).toEqual({ interrupted: true, retained: ["Test Book"], repaired: ["Next Book"] });
  } finally {
    controller.abort();
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("book and folder processing versions rebuild their own kinds and required dependent publications", async () => {
  // #given known real metadata and dated book, leaf and root publications
  const { root, outputPath, deps } = await tree();
  const book = join(outputPath, "Fiction", "Book.fb2", "entry.xml");
  const leaf = join(outputPath, "Fiction", "feed.xml");
  const rootFeed = join(outputPath, "feed.xml");
  const paths = [book, leaf, rootFeed];

  try {
    await Effect.runPromise(initialEngineCatalogue(deps));

    for (const path of paths) await utimes(path, ancient, ancient);
    // #when only the book processing version changes, then only the folder version changes
    const nextBook = nextVersion(PROCESSING_VERSIONS.book);
    const nextFolder = nextVersion(PROCESSING_VERSIONS.folder);

    await Effect.runPromise(initialEngineCatalogue(deps, { processingVersions: { book: nextBook } }));
    const bookVersion = await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs !== ancient.getTime()));

    for (const path of paths) await utimes(path, ancient, ancient);
    await Effect.runPromise(initialEngineCatalogue(deps, { processingVersions: { book: nextBook, folder: nextFolder } }));
    const folderVersion = await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs !== ancient.getTime()));
    // #then the selected kinds are rebuilt in place and acquisition results remain usable
    expect({
      bookVersion,
      folderVersion,
      titles: parseFeed(await readFile(leaf, "utf8")).entries.map((entry) => entry.title),
      parent: parseFeed(await readFile(rootFeed, "utf8")).entries.map((entry) => ({ href: entry.href, summary: entry.summary })),
      download: (await readFile(join(outputPath, "Fiction", "Book.fb2", "Book.fb2"))).equals(await readFile(fixture)),
    }).toEqual({
      bookVersion: [true, true, false],
      folderVersion: [false, true, true],
      titles: ["Test Book"],
      parent: [{ href: "/Fiction/feed.xml", summary: "📚 1" }],
      download: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a hint while an earlier real book publication is active keeps it eligible for startup repair", async () => {
  // #given known fixture metadata and a real entry write held after extraction
  const { root, sourcePath, outputPath, deps } = await tree();
  const source = join(sourcePath, "Fiction", "Book.fb2");
  const entry = join(outputPath, "Fiction", "Book.fb2", "entry.xml");
  await utimes(source, ancient, ancient);
  let entered = () => {};

  let release = () => {};

  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  let holdNext = false;

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      atomicWrite: async (path: string, content: string) => {
        if (holdNext && path === entry) {
          holdNext = false;
          entered();
          await released;
        }

        await deps.fs.atomicWrite(path, content);
      },
    },
  };

  try {
    await Effect.runPromise(initialEngineCatalogue(deps));
    // #when equal-stamp content is replaced and hinted before later work is declared
    await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(heldDeps).pipe(
          Effect.flatMap((session) =>
            Effect.sync(() => {
              holdNext = true;
            }).pipe(
              Effect.andThen(session.submit([CatalogueEvent.BookCreated({ parent: join(sourcePath, "Fiction"), name: "Book.fb2" })])),
              Effect.andThen(
                Effect.tryPromise({
                  try: async () => {
                    await writing;
                    await Bun.write(
                      source,
                      (await readFile(fixture, "utf8")).replace("<book-title>Test Book</book-title>", "<book-title>Next Book</book-title>"),
                    );
                    await utimes(source, ancient, ancient);
                  },
                  catch: (cause) => new Error(String(cause)),
                }).pipe(Effect.uninterruptible),
              ),
              Effect.andThen(session.submit([], { changedPaths: ["Fiction/Book.fb2"] })),
              Effect.andThen(Effect.sync(release)),
              Effect.andThen(session.awaitCompletion),
            ),
          ),
        ),
      ),
    );
    const earlier = parseFeed(`<feed>${await readFile(entry, "utf8")}</feed>`).entries.map((item) => item.title);
    await Effect.runPromise(initialEngineCatalogue(deps));
    // #then the earlier publication is available and a fresh instance repairs its real dependent feed
    expect({
      earlier,
      repaired: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((item) => item.title),
    }).toEqual({ earlier: ["Test Book"], repaired: ["Next Book"] });
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("adding one book to a folder does not reprocess unchanged sibling books", async () => {
  // #given a folder with several published sibling books and recorded freshness
  const { root, sourcePath, outputPath, deps } = await tree();
  await rm(join(sourcePath, "Fiction", "Book.fb2"));
  const existing = ["Alpha.txt", "Beta.txt", "Gamma.txt"];

  for (const name of existing) await Bun.write(join(sourcePath, "Fiction", name), `${name} source bytes`);

  const completedHandlers: string[] = [];

  const countedDeps = {
    ...deps,
    logger: {
      ...deps.logger,
      info: (component: string, message: string, fields?: LogContext) => {
        if (message === "Handler completed" && fields?.event_tag === "BookCreated") completedHandlers.push(String(fields.path));
        deps.logger.info(component, message, fields);
      },
    },
  };

  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* openLiveEngineCatalogue(countedDeps);
          const entryPaths = existing.map((name) => join(outputPath, "Fiction", name, "entry.xml"));

          yield* safePromise(async () => {
            for (const path of entryPaths) await utimes(path, ancient, ancient);
          });

          completedHandlers.length = 0;

          // #when one new book is added and the live OPDS pass refreshes the folder
          yield* safePromise(() => Bun.write(join(sourcePath, "Fiction", "Delta.txt"), "Delta.txt source bytes"));
          yield* session.notify(["Fiction/Delta.txt"]);
          yield* session.awaitCompletion;

          return yield* safePromise(async () => ({
            bookHandlers: completedHandlers.map((path) => path.replace(sourcePath + "/", "")).sort(),
            existingMtimes: await Promise.all(entryPaths.map(async (path) => (await stat(path)).mtimeMs)),
            titles: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8"))
              .entries.map((entry) => entry.title)
              .sort(),
            rootSummary: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.summary),
          }));
        }),
      ),
    );

    // #then only the new book is extracted while the existing entries stay fresh and folder feeds include all books
    expect(result).toEqual({
      bookHandlers: ["Fiction/Delta.txt"],
      existingMtimes: existing.map(() => ancient.getTime()),
      titles: ["Alpha", "Beta", "Delta", "Gamma"],
      rootSummary: ["📚 4"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
