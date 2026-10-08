import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, stat, utimes } from "node:fs/promises";
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

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "opds-engine-stop-"));
  const filesPath = join(root, "source");
  const dataPath = join(root, "output");
  await mkdir(filesPath);
  await copyFile(fixture, join(filesPath, "Book.fb2"));
  const ctx = await buildContext();

  return { root, filesPath, dataPath, deps: { ...ctx, config: { ...ctx.config, filesPath, dataPath, reconcileInterval: 0 } } };
}

test("stop awaits started book publication, closes HTTP admission and startup replays before freshness success", async () => {
  // #given a real previous catalogue and a held symlink/entry publication boundary
  const { root, filesPath, dataPath, deps } = await tree();
  const entered = gate();
  const release = gate();
  let hold = false;
  const entry = join(dataPath, "Book.fb2", "entry.xml");
  const link = join(dataPath, "Book.fb2", "Book.fb2");

  const runtime = createLiveEngineLifecycle({
    ...deps,
    fs: {
      ...deps.fs,
      symlink: async (target: string, path: string) => {
        await deps.fs.symlink(target, path);

        if (hold && path === link) {
          hold = false;
          entered.open();
          await release.promise;
        }
      },
    },
  });

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime, { shouldProcess: () => true }) });
  let stopped = false;

  try {
    await runtime.start();
    const source = (await readFile(fixture, "utf8")).replace("<book-title>Test Book</book-title>", "<book-title>Next Book</book-title>");
    await Bun.write(join(filesPath, "Book.fb2"), source);
    hold = true;
    await runtime.requestScan({ kind: "resync", force: false });
    await entered.promise;
    await runtime.requestScan({ kind: "resync", force: true });

    // #when stop reaches the public transport while publication is still held
    const stop = runtime.stop().then(() => {
      stopped = true;
    });

    await Bun.sleep(25);
    const resync = await fetch(new URL("/resync", server.url), { method: "POST" });

    const watcher = await fetch(new URL("/events/books", server.url), {
      method: "POST",
      body: JSON.stringify({ parent: filesPath, name: "Book.fb2", events: "CLOSE_WRITE" }),
    });

    const during = { stopped, accepting: runtime.accepting(), resync: resync.status, watcher: watcher.status };
    release.open();
    await stop;
    const state = await runtime.status();
    const bookPublished = (await readFile(entry, "utf8")).includes("<title>Next Book</title>");
    const target = await readlink(link);
    const oldFeed = parseFeed(await readFile(join(dataPath, "feed.xml"), "utf8")).entries.map((book) => book.title);
    const ancient = new Date("2020-01-01T00:00:00Z");
    await utimes(entry, ancient, ancient);
    const restarted = createLiveEngineLifecycle(deps);

    try {
      await restarted.start();
      const replayed = (await stat(entry)).mtimeMs !== ancient.getTime();
      await restarted.stop();
      await utimes(entry, ancient, ancient);
      const repeated = createLiveEngineLifecycle(deps);

      try {
        await repeated.start();
        // #then the safe pair survived stop, unfinished cascades replayed and subsequent warm execution is valid
        expect({
          during,
          state,
          bookPublished,
          target,
          oldFeed,
          replayed,
          final: parseFeed(await readFile(join(dataPath, "feed.xml"), "utf8")).entries.map((book) => book.title),
          download: await readFile(link, "utf8"),
          warmKeptEntry: (await stat(entry)).mtimeMs === ancient.getTime(),
        }).toEqual({
          during: { stopped: false, accepting: false, resync: 503, watcher: 503 },
          state: { state: "stopped", pass: null, followUp: null, work: { state: "stopped", active: null, pending: 0, errors: [] } },
          bookPublished: true,
          target: join(filesPath, "Book.fb2"),
          oldFeed: ["Test Book"],
          replayed: true,
          final: ["Next Book"],
          download: source,
          warmKeptEntry: true,
        });
      } finally {
        await repeated.stop();
      }
    } finally {
      await restarted.stop();
    }
  } finally {
    release.open();
    await runtime.stop();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("stop during initial preparation settles startup without a fatal failure and permits restart", async () => {
  // #given an initial real book read held before publication and an observed startup promise
  const { root, dataPath, deps } = await tree();
  const entered = gate();
  const release = gate();
  const fatal: unknown[] = [];

  const runtime = createLiveEngineLifecycle(
    {
      ...deps,
      fs: {
        ...deps.fs,
        stat: async (path: string) => {
          const result = await deps.fs.stat(path);
          entered.open();
          await release.promise;

          return result;
        },
      },
    },
    {
      onFatal: (cause) => {
        fatal.push(cause);
      },
    },
  );

  let startup = "pending";

  const starting = runtime.start().then(
    () => {
      startup = "started";
    },
    () => {
      startup = "cancelled";
    },
  );

  try {
    await entered.promise;
    // #when stop interrupts startup and joins the owned read
    const stopping = runtime.stop();
    release.open();
    await stopping;
    await Bun.sleep(10);
    const stopped = await runtime.status();
    const entryExisted = await Bun.file(join(dataPath, "Book.fb2", "entry.xml")).exists();
    const restarted = createLiveEngineLifecycle(deps);

    try {
      await restarted.start();
      // #then cancellation settles startup without an ordinary fatal error and scanning recovers the real book
      expect({
        startup,
        stopped,
        fatal,
        entryExisted,
        final: parseFeed(await readFile(join(dataPath, "feed.xml"), "utf8")).entries.map((book) => book.title),
      }).toEqual({
        startup: "cancelled",
        stopped: { state: "stopped", pass: null },
        fatal: [],
        entryExisted: false,
        final: ["Test Book"],
      });
      await starting;
    } finally {
      await restarted.stop();
    }
  } finally {
    release.open();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("stop awaits a non-cancellable preparation read without starting publication or reporting failure", async () => {
  // #given an old real entry and a preparation stat whose native Promise is held
  const { root, filesPath, dataPath, deps } = await tree();
  const initial = createLiveEngineLifecycle(deps);
  await initial.start();
  await initial.stop();
  const entry = join(dataPath, "Book.fb2", "entry.xml");
  const before = await readFile(entry, "utf8");
  const entered = gate();
  const release = gate();
  const failures: unknown[] = [];

  const runtime = createLiveEngineLifecycle({
    ...deps,
    logger: {
      ...deps.logger,
      error: (...args: unknown[]) => {
        failures.push(args);
      },
    },
    fs: {
      ...deps.fs,
      stat: async (path: string) => {
        const result = await deps.fs.stat(path);

        if (path === join(filesPath, "Book.fb2")) {
          entered.open();
          await release.promise;
        }

        return result;
      },
    },
  });

  let stopped = false;

  try {
    await runtime.start();
    await runtime.requestScan({ kind: "resync", force: true });
    await entered.promise;

    // #when stop cancels preparation but the owned read has not returned
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });

    await Bun.sleep(25);
    const awaitedRead = !stopped;
    release.open();
    await stopping;
    // #then stop joined the read, retained the entry/link and exposes no failed handler
    expect({
      awaitedRead,
      failures,
      state: await runtime.status(),
      entry: await readFile(entry, "utf8"),
      target: await readlink(join(dataPath, "Book.fb2", "Book.fb2")),
    }).toEqual({
      awaitedRead: true,
      failures: [],
      state: { state: "stopped", pass: null, followUp: null, work: { state: "stopped", pending: 0, active: null, errors: [] } },
      entry: before,
      target: join(filesPath, "Book.fb2"),
    });
  } finally {
    release.open();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
