import { test, expect } from "bun:test";
import { Effect, Cause, Exit } from "effect";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes } from "node:fs/promises";
import { engineStatePath, acquireOutputTree } from "@seigiard/sync-engine";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialEngineCatalogue, openEngineCatalogue } from "../../../src/lifecycle/initial-engine-catalogue.ts";
import { buildContext } from "../../../src/context.ts";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import type { LogContext } from "../../../src/logging/types.ts";

const fixture = join(import.meta.dir, "../../../files/test/Test Book - Test Author.fb2");

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Error(String(cause)) }).pipe(Effect.uninterruptible);

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "opds-engine-recovery-"));
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;

    throw error;
  }
}

test("a failed book update retains successful artifacts while an independent book publishes", async () => {
  // #given an independently known FB2 and its successful production artifacts
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Fiction"));
  await copyFile(fixture, join(sourcePath, "Fiction", "Book.fb2"));

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(deps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              const book = join(outputPath, "Fiction", "Book.fb2");
              const before = await Promise.all(["entry.xml", "cover.jpg", "thumb.jpg"].map((name) => readFile(join(book, name))));
              // #when this source becomes unreadable to the extractor and independent work arrives
              await Bun.write(join(sourcePath, "Fiction", "Book.fb2"), "Not a FictionBook");
              await Bun.write(
                join(sourcePath, "Fiction", "Independent.fb2"),
                (await readFile(fixture, "utf8")).replace(
                  "<book-title>Test Book</book-title>",
                  "<book-title>Independent Book</book-title>",
                ),
              );
              await Effect.runPromise(
                session.submit([
                  CatalogueEvent.BookCreated({ parent: join(sourcePath, "Fiction"), name: "Book.fb2" }),
                  CatalogueEvent.BookCreated({ parent: join(sourcePath, "Fiction"), name: "Independent.fb2" }),
                ]),
              );
              await Effect.runPromise(session.awaitCompletion);
              const status = await Effect.runPromise(session.status);

              return {
                retained: await Promise.all(
                  ["entry.xml", "cover.jpg", "thumb.jpg"].map(async (name, index) =>
                    (await readFile(join(book, name))).equals(before[index]!),
                  ),
                ),
                titles: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((entry) => entry.title),
                count: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.summary),
                state: status.state,
                pending: status.pending,
                active: status.active,
                errors: status.errors.map((error) => ({
                  tag: error.work._tag,
                  message: Cause.pretty(error.cause).includes("not a readable FictionBook"),
                })),
              };
            }),
          ),
        ),
      ),
    );

    // #then the damaged update cannot replace the successful result or stop independent work
    expect(observation).toEqual({
      retained: [true, true, true],
      titles: ["Independent Book", "Test Book"],
      count: ["📚 2"],
      state: "complete",
      pending: 0,
      active: null,
      errors: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed file read retains its entry and independent work still publishes", async () => {
  // #given real successful book output and a denied external stat operation
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  let fault = false;

  const faultyDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      stat: async (path: string) => {
        if (fault && path === join(sourcePath, "Book.fb2")) throw Object.assign(new Error("File read denied"), { code: "EACCES" });

        return deps.fs.stat(path);
      },
    },
  };

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(faultyDeps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              const before = await readFile(join(outputPath, "Book.fb2", "entry.xml"));
              // #when the failed file and a real independent TXT enter the public session
              fault = true;
              await Bun.write(join(sourcePath, "Independent.txt"), "Independent source bytes");
              await Effect.runPromise(
                session.submit([
                  CatalogueEvent.BookCreated({ parent: sourcePath, name: "Book.fb2" }),
                  CatalogueEvent.BookCreated({ parent: sourcePath, name: "Independent.txt" }),
                ]),
              );
              await Effect.runPromise(session.awaitCompletion);
              const status = await Effect.runPromise(session.status);

              return {
                retained: (await readFile(join(outputPath, "Book.fb2", "entry.xml"))).equals(before),
                titles: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.title),
                state: status.state,
                errors: status.errors.map((error) => Cause.pretty(error.cause).includes("File read denied")),
              };
            }),
          ),
        ),
      ),
    );

    // #then only the independent result changes while the failure stays public
    expect(observation).toEqual({ retained: true, titles: ["Independent", "Test Book"], state: "complete-with-errors", errors: [true] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing derived directory creation is isolated to that folder work", async () => {
  // #given one source folder whose output mkdir fails and one independent real book
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Blocked", "Nested"), { recursive: true });
  await copyFile(fixture, join(sourcePath, "Good.fb2"));
  const blockedOutput = join(outputPath, "Blocked", "Nested");

  const faultyDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        if (path === blockedOutput) throw Object.assign(new Error("Output directory denied"), { code: "EACCES" });

        await deps.fs.mkdir(path, options);
      },
    },
  };

  try {
    // #when the first pass declares both sources
    const exit = await Effect.runPromiseExit(initialEngineCatalogue(faultyDeps));

    // #then the independent book publishes even though the folder work fails
    expect({
      failed: exit._tag,
      good: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.title),
      blocked: await Bun.file(join(blockedOutput, "feed.xml")).exists(),
    }).toEqual({ failed: "Failure", good: ["Blocked", "Test Book"], blocked: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stable broken book with a previous entry converges after one pass", async () => {
  // #given a damaged book with a previous fallback-looking entry and an independent unchanged book
  const { root, sourcePath, outputPath, deps } = await tree();
  await Bun.write(join(sourcePath, "Broken.fb2"), "Not a FictionBook");
  await copyFile(fixture, join(sourcePath, "Good.fb2"));
  await Effect.runPromise(initialEngineCatalogue(deps));
  const goodEntry = join(outputPath, "Good.fb2", "entry.xml");
  const brokenEntry = join(outputPath, "Broken.fb2", "entry.xml");
  const ancient = new Date("2020-01-01T00:00:00Z");
  await utimes(goodEntry, ancient, ancient);
  await rm(join(outputPath, ".sync-engine"), { recursive: true, force: true });
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
    // #when a fresh engine sees the stable broken source twice
    await Effect.runPromise(initialEngineCatalogue(countedDeps));
    const first = [...completedHandlers];
    await utimes(goodEntry, ancient, ancient);
    completedHandlers.length = 0;
    await Effect.runPromise(initialEngineCatalogue(countedDeps));

    // #then the failure is recorded as current and the second pass reuses both books
    expect({
      second: completedHandlers,
      firstHasBroken: first.includes("BookCreated"),
      goodMtime: (await stat(goodEntry)).mtimeMs,
      brokenTitle: parseFeed(`<feed>${await readFile(brokenEntry, "utf8")}</feed>`).entries.map((entry) => entry.title),
    }).toEqual({
      second: [],
      firstHasBroken: true,
      goodMtime: ancient.getTime(),
      brokenTitle: ["Broken"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete deletion observations retain data until a confirmed removal refreshes its parent", async () => {
  // #given a successful nested book and a failing parent-directory read
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Fiction"));
  await copyFile(fixture, join(sourcePath, "Fiction", "Book.fb2"));
  let fault = false;

  const faultyDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      readdir: async (path: string) => {
        if (fault && path === join(sourcePath, "Fiction"))
          throw Object.assign(new Error("Deletion observation denied"), { code: "EACCES" });

        return deps.fs.readdir(path);
      },
    },
  };

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(faultyDeps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              const book = join(outputPath, "Fiction", "Book.fb2", "entry.xml");
              const before = await readFile(book);
              const hint = CatalogueEvent.BookDeleted({ parent: join(sourcePath, "Fiction"), name: "Book.fb2" });
              // #when the source disappears but its parent cannot be observed
              await rm(join(sourcePath, "Fiction", "Book.fb2"));
              fault = true;
              await Effect.runPromise(session.submit([hint]));
              await Effect.runPromise(session.awaitCompletion);
              const failed = await Effect.runPromise(session.status);
              const retained = (await readFile(book)).equals(before);
              fault = false;
              await Effect.runPromise(
                session.submit([CatalogueEvent.BookDeleted({ parent: join(sourcePath, "Fiction"), name: "Book.fb2" })]),
              );
              await Effect.runPromise(session.awaitCompletion);
              const completed = await Effect.runPromise(session.status);

              return {
                failed: failed.state,
                errors: failed.errors.map((error) => Cause.pretty(error.cause).includes("Deletion observation denied")),
                retained,
                removed: !(await Bun.file(book).exists()),
                titles: parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((entry) => entry.title),
                summaries: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.summary),
                completed: completed.state,
                remainingErrors: completed.errors.length,
              };
            }),
          ),
        ),
      ),
    );

    // #then confirmed absence removes its association and successful retry clears the failed observation
    expect(observation).toEqual({
      failed: "complete-with-errors",
      errors: [true],
      retained: true,
      removed: true,
      titles: [],
      summaries: [undefined],
      completed: "complete",
      remainingErrors: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("moves use old-path removal and new-path creation while stale hints preserve current results", async () => {
  // #given a book under its old path and an independent neighbouring book
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Old"));
  await mkdir(join(sourcePath, "New"));
  await copyFile(fixture, join(sourcePath, "Old", "Book.fb2"));
  await Bun.write(join(sourcePath, "Keep.txt"), "Neighbour source");

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(deps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              // #when the file moves and a stale deletion hint follows its new publication
              await rename(join(sourcePath, "Old", "Book.fb2"), join(sourcePath, "New", "Moved.fb2"));
              await Effect.runPromise(
                session.submit([
                  CatalogueEvent.BookDeleted({ parent: join(sourcePath, "Old"), name: "Book.fb2" }),
                  CatalogueEvent.BookCreated({ parent: join(sourcePath, "New"), name: "Moved.fb2" }),
                ]),
              );
              await Effect.runPromise(session.awaitCompletion);
              const entry = await readFile(join(outputPath, "New", "Moved.fb2", "entry.xml"));
              await Effect.runPromise(session.submit([CatalogueEvent.BookDeleted({ parent: join(sourcePath, "New"), name: "Moved.fb2" })]));
              await Effect.runPromise(session.awaitCompletion);
              const staleRetained = (await readFile(join(outputPath, "New", "Moved.fb2", "entry.xml"))).equals(entry);
              await rm(join(sourcePath, "Old"), { recursive: true });
              await Effect.runPromise(session.submit([CatalogueEvent.FolderDeleted({ parent: sourcePath, name: "Old" })]));
              await Effect.runPromise(session.awaitCompletion);

              return {
                oldGone: !(await Bun.file(join(outputPath, "Old", "feed.xml")).exists()),
                staleRetained,
                newTitles: parseFeed(await readFile(join(outputPath, "New", "feed.xml"), "utf8")).entries.map((item) => item.title),
                download: (await readFile(join(outputPath, "New", "Moved.fb2", "Moved.fb2"), "utf8")) === (await readFile(fixture, "utf8")),
                rootReferences: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map(
                  (item) => item.href ?? item.acquisitions?.[0]?.href,
                ),
                neighbour: await readFile(join(sourcePath, "Keep.txt"), "utf8"),
                state: (await Effect.runPromise(session.status)).state,
              };
            }),
          ),
        ),
      ),
    );

    // #then results follow relative paths without retaining an old parent reference
    expect(observation).toEqual({
      oldGone: true,
      staleRetained: true,
      newTitles: ["Test Book"],
      download: true,
      rootReferences: ["/New/feed.xml", "/Keep.txt/Keep.txt"],
      neighbour: "Neighbour source",
      state: "complete",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["folder-to-book", "book-to-folder"] as const)("a source kind change removes obsolete %s artifacts", async (mode) => {
  // #given a published representation that will be replaced by the opposite source kind
  const { root, sourcePath, outputPath, deps } = await tree();
  const name = "Novel.fb2";

  try {
    if (mode === "folder-to-book") {
      await mkdir(join(sourcePath, name));
      await copyFile(fixture, join(sourcePath, name, "Inside.fb2"));
    } else {
      await copyFile(fixture, join(sourcePath, name));
    }

    await Effect.runPromise(initialEngineCatalogue(deps));

    if (mode === "folder-to-book") {
      await rm(join(sourcePath, name), { recursive: true });
      await copyFile(fixture, join(sourcePath, name));
    } else {
      await rm(join(sourcePath, name));
      await mkdir(join(sourcePath, name));
      await copyFile(fixture, join(sourcePath, name, "Inside.fb2"));
    }

    // #when the next pass observes the same relative path with the opposite kind
    await Effect.runPromise(initialEngineCatalogue(deps));

    // #then the parent points at the current representation, not the obsolete marker
    expect({
      rootReferences: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map(
        (entry) => entry.href ?? entry.acquisitions?.[0]?.href,
      ),
      folderMarker: await Bun.file(join(outputPath, name, "_entry.xml")).exists(),
      bookMarker: await Bun.file(join(outputPath, name, "entry.xml")).exists(),
    }).toEqual(
      mode === "folder-to-book"
        ? { rootReferences: [`/${name}/${name}`], folderMarker: false, bookMarker: true }
        : { rootReferences: [`/${name}/feed.xml`], folderMarker: true, bookMarker: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("underscore-prefixed source deletions are cleaned from DATA", async () => {
  // #given a supported underscore-prefixed source folder with a published book
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "_Archive"));
  await copyFile(fixture, join(sourcePath, "_Archive", "Book.fb2"));

  try {
    await Effect.runPromise(initialEngineCatalogue(deps));
    const entry = join(outputPath, "_Archive", "Book.fb2", "entry.xml");
    const before = await pathExists(entry);

    // #when that source disappears while the service is down
    await rm(join(sourcePath, "_Archive"), { recursive: true });
    await Effect.runPromise(initialEngineCatalogue(deps));

    // #then orphan cleanup removes the direct URL artifacts too
    expect({ before, afterEntry: await pathExists(entry), afterArchive: await pathExists(join(outputPath, "_Archive")) }).toEqual({
      before: true,
      afterEntry: false,
      afterArchive: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup refuses a symlinked DATA ancestor instead of deleting through it", async () => {
  // #given a published folder whose DATA ancestor is replaced by an operator-created symlink
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Fiction"));
  await copyFile(fixture, join(sourcePath, "Fiction", "Book.fb2"));
  await Effect.runPromise(initialEngineCatalogue(deps));
  const external = join(root, "external");
  await rename(join(outputPath, "Fiction"), external);
  await symlink(external, join(outputPath, "Fiction"));
  await rm(join(sourcePath, "Fiction", "Book.fb2"));

  try {
    // #when startup cleanup observes the book as absent through that symlinked DATA ancestor
    const completion = await Effect.runPromiseExit(initialEngineCatalogue(deps));

    const observation = {
      completion: completion._tag,
      failedSafely: Exit.isFailure(completion) && Cause.pretty(completion.cause).includes("Output ancestor is not an owned directory"),
      externalEntry: await pathExists(join(external, "Book.fb2", "entry.xml")),
      sourceGone: !(await pathExists(join(sourcePath, "Fiction", "Book.fb2"))),
    };

    // #then the external target survives and the failed cleanup is public
    expect(observation).toEqual({ completion: "Failure", failedSafely: true, externalEntry: true, sourceGone: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable source root and out-of-tree hints cannot authorize cleanup", async () => {
  // #given real published results and neighbouring user data
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  await mkdir(join(root, "user"));
  await Bun.write(join(root, "user", "keep"), "User data");

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(deps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              const entry = join(outputPath, "Book.fb2", "entry.xml");
              const before = await readFile(entry);
              // #when the whole source root becomes unavailable and an unsafe event also arrives
              await rename(sourcePath, join(root, "offline-source"));
              await Effect.runPromise(
                session.submit([
                  CatalogueEvent.BookDeleted({ parent: sourcePath, name: "Book.fb2" }),
                  CatalogueEvent.FolderDeleted({ parent: sourcePath, name: "../user" }),
                ]),
              );
              await Effect.runPromise(session.awaitCompletion);
              const status = await Effect.runPromise(session.status);

              return {
                retained: (await readFile(entry)).equals(before),
                user: await readFile(join(root, "user", "keep"), "utf8"),
                source: (await readFile(join(root, "offline-source", "Book.fb2"), "utf8")) === (await readFile(fixture, "utf8")),
                state: status.state,
                failures: status.errors.length,
                feed: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((item) => item.title),
              };
            }),
          ),
        ),
      ),
    );

    // #then source unavailability and out-of-area declarations preserve both ownership boundaries
    expect(observation).toEqual({
      retained: true,
      user: "User data",
      source: true,
      state: "complete-with-errors",
      failures: 2,
      feed: ["Test Book"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary folder cleanup preserves configured state and its held lease inode", async () => {
  // #given legal OPDS folder names and a held public-engine lease
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Fiction"));
  await copyFile(fixture, join(sourcePath, "Fiction", "Book.fb2"));

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(deps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              const statePath = await Effect.runPromise(engineStatePath(outputPath, join(outputPath, ".sync-engine")));
              const lock = join(statePath, "lock");
              const before = (await stat(lock)).ino;
              await Bun.write(join(statePath, "saved-state"), "Persistent state bytes");

              const titles = parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8")).entries.map((item) => item.title);

              // #when that source is removed, associated cleanup runs while the lease stays held
              await rm(join(sourcePath, "Fiction"), { recursive: true });
              await Effect.runPromise(session.submit([CatalogueEvent.FolderDeleted({ parent: sourcePath, name: "Fiction" })]));
              await Effect.runPromise(session.awaitCompletion);

              const contender = await Effect.runPromiseExit(
                Effect.acquireRelease(acquireOutputTree(outputPath, join(outputPath, ".sync-engine")), (release) =>
                  Effect.promise(release),
                ).pipe(Effect.scoped),
              );

              return {
                titles,
                removed: !(await Bun.file(join(outputPath, "Fiction", "feed.xml")).exists()),
                sameInode: (await stat(lock)).ino === before,
                saved: await readFile(join(statePath, "saved-state"), "utf8"),
                stateFiles: (await readdir(statePath)).sort(),
                owned: contender._tag,
                references: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((item) => item.href),
              };
            }),
          ),
        ),
      ),
    );

    // #then cleanup cannot unlink the bookkeeping inode or free ownership early
    expect(observation).toEqual({
      titles: ["Test Book"],
      removed: true,
      sameInode: true,
      saved: "Persistent state bytes",
      stateFiles: ["freshness.json", "lock", "saved-state"],
      owned: "Failure",
      references: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OPDS ignores dot-source subtrees before traversal and does not publish hidden hints", async () => {
  // #given a supported book and an unreadable excluded dot subtree
  const { root, sourcePath, outputPath, deps } = await tree();
  const hidden = join(sourcePath, ".ignored");
  await mkdir(hidden);
  await copyFile(fixture, join(hidden, "Hidden.fb2"));
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  await chmod(hidden, 0o000);

  try {
    // #when public startup and later work encounter this application-excluded source
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(deps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              await Effect.runPromise(
                session.submit([
                  CatalogueEvent.FolderCreated({ parent: sourcePath, name: ".ignored" }),
                  CatalogueEvent.BookCreated({ parent: hidden, name: "Hidden.fb2" }),
                ]),
              );
              await Effect.runPromise(session.awaitCompletion);
              const status = await Effect.runPromise(session.status);

              return {
                titles: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((item) => item.title),
                hiddenFeed: await Bun.file(join(outputPath, ".ignored", "feed.xml")).exists(),
                hiddenEntry: await Bun.file(join(outputPath, ".ignored", "Hidden.fb2", "entry.xml")).exists(),
                state: status.state,
                errors: status.errors.length,
              };
            }),
          ),
        ),
      ),
    );

    // #then only supported sources enter the representation, even when the excluded subtree is unreadable
    expect(observation).toEqual({ titles: ["Test Book"], hiddenFeed: false, hiddenEntry: false, state: "complete", errors: 0 });
  } finally {
    await chmod(hidden, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["folder", "root"])("a failed %s source read retains its previously published feed", async (kind) => {
  // #given a successful catalogue and a fault at the real source directory-read boundary
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Fiction"));
  await copyFile(fixture, join(sourcePath, "Fiction", "Book.fb2"));
  const source = kind === "root" ? sourcePath : join(sourcePath, "Fiction");
  const output = kind === "root" ? outputPath : join(outputPath, "Fiction");
  let fault = false;

  const faultyDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      readdir: async (path: string) => {
        if (fault && path === source) throw Object.assign(new Error("Source read denied"), { code: "EACCES" });

        return deps.fs.readdir(path);
      },
    },
  };

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(faultyDeps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              const before = await readFile(join(output, "feed.xml"));
              // #when a source read fails during submitted work
              fault = true;
              await Effect.runPromise(session.submit([CatalogueEvent.FolderMetaSyncRequested({ path: output })]));
              await Effect.runPromise(session.awaitCompletion);
              const status = await Effect.runPromise(session.status);

              return {
                retained: (await readFile(join(output, "feed.xml"))).equals(before),
                state: status.state,
                pending: status.pending,
                active: status.active,
                errors: status.errors.map((error) => Cause.pretty(error.cause).includes("Source read denied")),
              };
            }),
          ),
        ),
      ),
    );

    // #then failure does not masquerade as successful source verification
    expect(observation).toEqual({ retained: true, state: "complete-with-errors", pending: 0, active: null, errors: [true] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed derived-folder read cannot replace its published feed with an empty catalogue", async () => {
  // #given a successful real catalogue and a failing read of its derived child entries
  const { root, sourcePath, outputPath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  let fault = false;

  const faultyDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      readdir: async (path: string) => {
        if (fault && path === outputPath) throw Object.assign(new Error("Derived read denied"), { code: "EACCES" });

        return deps.fs.readdir(path);
      },
    },
  };

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(faultyDeps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              const before = await readFile(join(outputPath, "feed.xml"));
              // #when the existing real refresh handler cannot read its completed dependencies
              fault = true;
              await Effect.runPromise(session.submit([CatalogueEvent.FolderMetaSyncRequested({ path: outputPath })]));
              await Effect.runPromise(session.awaitCompletion);
              const status = await Effect.runPromise(session.status);

              return {
                retained: (await readFile(join(outputPath, "feed.xml"))).equals(before),
                titles: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.title),
                state: status.state,
                errors: status.errors.map((error) => Cause.pretty(error.cause).includes("EACCES")),
              };
            }),
          ),
        ),
      ),
    );

    // #then failed publication preparation leaves the successful result available
    expect(observation).toEqual({ retained: true, titles: ["Test Book"], state: "complete-with-errors", errors: [true] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
