import { test, expect } from "bun:test";
import { Effect } from "effect";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../../src/context.ts";
import { openLiveEngineCatalogue } from "../../../src/lifecycle/live-engine-catalogue.ts";
import { parseFeed } from "../../../src/render/parse-feed.ts";

const fixture = join(import.meta.dir, "../../../files/test/Test Book - Test Author.fb2");

const ancient = new Date("2020-01-01T00:00:00Z");

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Error(String(cause)) }).pipe(Effect.uninterruptible);

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "opds-live-freshness-"));
  const sourcePath = join(root, "source");
  const outputPath = join(root, "output");
  await mkdir(join(sourcePath, "Fiction"), { recursive: true });
  await copyFile(fixture, join(sourcePath, "Fiction", "Book.fb2"));
  await utimes(join(sourcePath, "Fiction", "Book.fb2"), ancient, ancient);
  const ctx = await buildContext();

  return {
    root,
    sourcePath,
    outputPath,
    deps: { ...ctx, config: { ...ctx.config, filesPath: sourcePath, dataPath: outputPath, reconcileInterval: 0 } },
  };
}

test("an ordinary live pass applies a changed book processing version to an equal-stamp source", async () => {
  // #given independently known metadata and dated successful real publications
  const { root, sourcePath, outputPath, deps } = await tree();
  const source = join(sourcePath, "Fiction", "Book.fb2");
  const paths = ["Fiction/Book.fb2/entry.xml", "Fiction/feed.xml", "Fiction/index.html", "feed.xml", "index.html"];
  const processingVersions = { book: "1" };

  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* openLiveEngineCatalogue(deps, { processingVersions });
          const before = yield* io(() => stat(source));
          yield* io(async () => {
            for (const path of paths) await utimes(join(outputPath, path), ancient, ancient);
            await Bun.write(
              source,
              (await readFile(fixture, "utf8")).replace("<book-title>Test Book</book-title>", "<book-title>Next Book</book-title>"),
            );
            await utimes(source, ancient, ancient);
          });
          // #when processing changes, ordinary pass admission carries no source hint or force
          processingVersions.book = "2";
          const admission = yield* session.requestPass();
          yield* session.awaitCompletion;

          return yield* io(async () => {
            const after = await stat(source);

            return {
              admission,
              sameStamp: before.size === after.size && before.mtimeMs === after.mtimeMs,
              entry: parseFeed(`<feed>${await readFile(join(outputPath, paths[0]!), "utf8")}</feed>`).entries.map((entry) => entry.title),
              leaf: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((entry) => entry.title),
              rewritten: await Promise.all(paths.map(async (path) => (await stat(join(outputPath, path))).mtimeMs !== ancient.getTime())),
              download: (await readFile(join(outputPath, "Fiction", "Book.fb2", "Book.fb2"), "utf8")).includes(
                "<book-title>Next Book</book-title>",
              ),
            };
          });
        }),
      ),
    );

    // #then required leaf publications update while unchanged parent summaries stop the cascade
    expect(result).toEqual({
      admission: "started",
      sameStamp: true,
      entry: ["Next Book"],
      leaf: ["Next Book"],
      rewritten: [true, true, true, false, false],
      download: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ordinary live content check repairs an equal-stamp replacement without a watcher hint", async () => {
  // #given a real live catalogue with content checks and independently dated publications
  const { root, sourcePath, outputPath, deps } = await tree();
  const source = join(sourcePath, "Fiction", "Book.fb2");
  const paths = ["Fiction/Book.fb2/entry.xml", "Fiction/feed.xml", "Fiction/index.html", "feed.xml", "index.html"];

  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* openLiveEngineCatalogue(deps, { check: "content" });
          const before = yield* io(() => stat(source));
          yield* io(async () => {
            for (const path of paths) await utimes(join(outputPath, path), ancient, ancient);
          });
          yield* session.requestPass();
          yield* session.awaitCompletion;
          const warm = yield* io(() => Promise.all(paths.map(async (path) => (await stat(join(outputPath, path))).mtimeMs)));
          // #when bytes change with identical size and mtime and no notification
          yield* io(async () => {
            await Bun.write(
              source,
              (await readFile(fixture, "utf8")).replace("<book-title>Test Book</book-title>", "<book-title>Next Book</book-title>"),
            );
            await utimes(source, ancient, ancient);
          });
          const admission = yield* session.requestPass();
          yield* session.awaitCompletion;

          return yield* io(async () => {
            const after = await stat(source);

            return {
              admission,
              warm,
              sameStamp: before.size === after.size && before.mtimeMs === after.mtimeMs,
              entry: parseFeed(`<feed>${await readFile(join(outputPath, paths[0]!), "utf8")}</feed>`).entries.map((entry) => entry.title),
              leaf: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((entry) => entry.title),
              rewritten: await Promise.all(paths.map(async (path) => (await stat(join(outputPath, path))).mtimeMs !== ancient.getTime())),
              download: (await readFile(join(outputPath, "Fiction", "Book.fb2", "Book.fb2"), "utf8")).includes(
                "<book-title>Next Book</book-title>",
              ),
            };
          });
        }),
      ),
    );

    // #then hashing repairs actual metadata and downloads, while warm checks and parent summaries retain their files
    expect(result).toEqual({
      admission: "started",
      warm: [1577836800000, 1577836800000, 1577836800000, 1577836800000, 1577836800000],
      sameStamp: true,
      entry: ["Next Book"],
      leaf: ["Next Book"],
      rewritten: [true, true, true, false, false],
      download: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
