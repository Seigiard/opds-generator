import { test, expect } from "bun:test";
import { Effect } from "effect";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineCatalogue } from "../../../src/lifecycle/initial-engine-catalogue.ts";
import { buildContext } from "../../../src/context.ts";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import { assertCoverMatchesReference } from "../../helpers/image-compare.ts";

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Error(String(cause)) }).pipe(Effect.uninterruptible);

const fixtures = join(import.meta.dir, "../../../files/test");

function gate() {
  let open = () => {};

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "opds-engine-catalogue-"));
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

test("new folder references wait for their child feed target", async () => {
  // #given an initialized real catalogue and a held new child-feed publication
  const { root, sourcePath, outputPath, deps } = await tree();
  const entered = gate();
  const release = gate();
  const childFeed = join(outputPath, "Fiction", "feed.xml");

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      atomicWrite: async (path: string, content: string) => {
        if (path === childFeed) {
          entered.open();
          await release.promise;
        }

        await deps.fs.atomicWrite(path, content);
      },
    },
  };

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(heldDeps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              await mkdir(join(sourcePath, "Fiction"));
              // #when new-folder work reaches the required child-feed boundary
              await Effect.runPromise(session.submit([CatalogueEvent.FolderCreated({ parent: sourcePath, name: "Fiction" })]));
              await entered.promise;
              const prematureEntry = await Bun.file(join(outputPath, "Fiction", "_entry.xml")).exists();
              const prematureReference = parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.href);
              release.open();
              await Effect.runPromise(session.awaitCompletion);

              return {
                prematureEntry,
                prematureReference,
                finalReference: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((entry) => entry.href),
                childTitles: parseFeed(await readFile(childFeed, "utf8")).entries.map((entry) => entry.title),
              };
            }),
          ),
        ),
      ),
    );

    // #then the required feed exists before its folder entry and parent reference
    expect(observation).toEqual({ prematureEntry: false, prematureReference: [], finalReference: ["/Fiction/feed.xml"], childTitles: [] });
  } finally {
    release.open();
    await rm(root, { recursive: true, force: true });
  }
});

const formats = [
  { fixture: "Test Book - Test Author.epub", name: "Book.epub", title: "Test Book", author: "Test Author", cover: true },
  { fixture: "Test Book - Test Author.fb2", name: "Book.fb2", title: "Test Book", author: "Test Author", cover: true },
  { fixture: "Test Book - Test Author.fb2.zip", name: "Book.fb2.zip", title: "Test Book", author: "Test Author", cover: true },
  { fixture: "Test Book - Test Author.fbz", name: "Book.fbz", title: "Test Book", author: "Test Author", cover: true },
  { fixture: "Test Book - Test Author.mobi", name: "Book.mobi", title: "Test Book", author: "Test Author", cover: true },
  { fixture: "Test Book - Test Author.mobi", name: "Book.azw", title: "Test Book", author: "Test Author", cover: true },
  { fixture: "Test Book - Test Author.azw3", name: "Book.azw3", title: "Test Book", author: "Test Author", cover: true },
  { fixture: "Test Book - Test Author.pdf", name: "Book.pdf", title: "Test Book", author: "Test Author", cover: true },
  { fixture: "Test Book - Test Author.djvu", name: "Book.djvu", title: "Test Book", author: "Test Author", cover: true },
  { fixture: "bobby_make_believe_sample.cbz", name: "Book.cbz", title: "Book", author: undefined, cover: true },
  { fixture: "bobby_make_believe_sample.cbr", name: "Book.cbr", title: "Book", author: undefined, cover: true },
  { fixture: "bobby_make_believe_sample.cb7", name: "Book.cb7", title: "Book", author: undefined, cover: true },
  { fixture: "bobby_make_believe_sample.cbt", name: "Book.cbt", title: "Book", author: undefined, cover: true },
  { fixture: "sample_text.txt", name: "Book.txt", title: "Book", author: undefined, cover: false },
];

test.each(formats)(
  "packaged engine retains $name metadata, covers, browser links and download bytes",
  async ({ fixture, name, title, author, cover }) => {
    // #given existing independent book fixtures and real production services
    const { root, sourcePath, outputPath, deps } = await tree();
    await mkdir(join(sourcePath, "Fiction"));
    await copyFile(join(fixtures, fixture), join(sourcePath, "Fiction", name));
    const missingTargets: string[] = [];

    const checkedDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        atomicWrite: async (path: string, content: string) => {
          if (path.endsWith(".xml")) {
            const model = parseFeed(path.endsWith("entry.xml") ? `<feed>${content}</feed>` : content);

            for (const entry of model.entries) {
              for (const target of [entry.href, entry.cover, entry.thumbnail, ...(entry.acquisitions?.map((link) => link.href) ?? [])]) {
                if (target && !(await Bun.file(join(outputPath, decodeURIComponent(target))).exists())) missingTargets.push(target);
              }
            }
          }

          await deps.fs.atomicWrite(path, content);
        },
      },
    };

    try {
      // #when the public packaged session processes the fixture through existing registrations
      const completed = await Effect.runPromise(
        Effect.scoped(openEngineCatalogue(checkedDeps).pipe(Effect.flatMap((session) => session.status))),
      );

      const leaf = parseFeed(await readFile(join(outputPath, "Fiction", "feed.xml"), "utf8"));
      const entry = leaf.entries[0];
      const href = `/Fiction/${name}/${name}`;
      const bookPath = join(outputPath, "Fiction", name);

      if (cover && author) {
        await assertCoverMatchesReference(await readFile(join(bookPath, "cover.jpg")));
        await assertCoverMatchesReference(await readFile(join(bookPath, "thumb.jpg")));
      }

      // #then independently known metadata and working artifacts are retained
      expect({
        state: completed.state,
        titles: leaf.entries.map((item) => item.title),
        author: entry?.author,
        download: entry?.acquisitions?.[0]?.href,
        browserDownload: (await readFile(join(outputPath, "Fiction", "index.html"), "utf8")).includes(`href="${href}"`),
        sameBytes: (await readFile(join(bookPath, name))).equals(await readFile(join(fixtures, fixture))),
        unchangedSource: (await readFile(join(sourcePath, "Fiction", name))).equals(await readFile(join(fixtures, fixture))),
        cover: await Bun.file(join(bookPath, "cover.jpg")).exists(),
        thumbnail: await Bun.file(join(bookPath, "thumb.jpg")).exists(),
        parent: parseFeed(await readFile(join(outputPath, "feed.xml"), "utf8")).entries.map((item) => ({
          href: item.href,
          summary: item.summary,
        })),
        missingTargets,
      }).toEqual({
        state: "complete",
        titles: [title],
        author,
        download: href,
        browserDownload: true,
        sameBytes: true,
        unchangedSource: true,
        cover,
        thumbnail: cover,
        parent: [{ href: "/Fiction/feed.xml", summary: "📚 1" }],
        missingTargets: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("nested additions update affected ancestors and metadata changes stop at unchanged summaries", async () => {
  // #given a real empty nested tree and initial catalogues
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Fiction", "SciFi"), { recursive: true });
  const ancient = new Date("2020-01-01T00:00:00Z");
  const rootFeed = join(outputPath, "feed.xml");
  const parentFeed = join(outputPath, "Fiction", "feed.xml");
  const leafFeed = join(outputPath, "Fiction", "SciFi", "feed.xml");
  const name = "Book.fb2";

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(deps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              await utimes(rootFeed, ancient, ancient);
              await utimes(parentFeed, ancient, ancient);
              // #when a real nested book is added, then its real metadata changes
              await copyFile(join(fixtures, "Test Book - Test Author.fb2"), join(sourcePath, "Fiction", "SciFi", name));
              await Effect.runPromise(session.submit([CatalogueEvent.BookCreated({ parent: join(sourcePath, "Fiction", "SciFi"), name })]));
              await Effect.runPromise(session.awaitCompletion);

              const afterAddition = {
                titles: parseFeed(await readFile(leafFeed, "utf8")).entries.map((entry) => entry.title),
                summaries: parseFeed(await readFile(parentFeed, "utf8")).entries.map((entry) => entry.summary),
                rootStopped: (await stat(rootFeed)).mtimeMs === ancient.getTime(),
                parentUpdated: (await stat(parentFeed)).mtimeMs !== ancient.getTime(),
              };

              await utimes(parentFeed, ancient, ancient);
              const original = await readFile(join(fixtures, "Test Book - Test Author.fb2"), "utf8");
              await Bun.write(
                join(sourcePath, "Fiction", "SciFi", name),
                original.replace("<book-title>Test Book</book-title>", "<book-title>Changed Book</book-title>"),
              );
              await Effect.runPromise(session.submit([CatalogueEvent.BookCreated({ parent: join(sourcePath, "Fiction", "SciFi"), name })]));
              await Effect.runPromise(session.awaitCompletion);

              return {
                afterAddition,
                titlesAfterChange: parseFeed(await readFile(leafFeed, "utf8")).entries.map((entry) => entry.title),
                ancestorsAfterChange: [(await stat(rootFeed)).mtimeMs, (await stat(parentFeed)).mtimeMs],
                state: (await Effect.runPromise(session.status)).state,
              };
            }),
          ),
        ),
      ),
    );

    // #then cascades preserve count summaries and stop where their summaries are unchanged
    expect(observation).toEqual({
      afterAddition: { titles: ["Test Book"], summaries: ["📚 1"], rootStopped: true, parentUpdated: true },
      titlesAfterChange: ["Changed Book"],
      ancestorsAfterChange: [ancient.getTime(), ancient.getTime()],
      state: "complete",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("held required ancestor publication prevents public completion while earlier results remain available", async () => {
  // #given existing real nested feeds and a held ancestor filesystem publication
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Fiction", "SciFi"), { recursive: true });
  const entered = gate();
  const release = gate();
  let holding = false;
  const parentFeed = join(outputPath, "Fiction", "feed.xml");

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      atomicWrite: async (path: string, content: string) => {
        if (holding && path === parentFeed) {
          entered.open();
          await release.promise;
        }

        await deps.fs.atomicWrite(path, content);
      },
    },
  };

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(heldDeps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              holding = true;
              await copyFile(join(fixtures, "Test Book - Test Author.epub"), join(sourcePath, "Fiction", "SciFi", "Book.epub"));
              // #when book work has published and its required ancestor is still held
              await Effect.runPromise(
                session.submit([CatalogueEvent.BookCreated({ parent: join(sourcePath, "Fiction", "SciFi"), name: "Book.epub" })]),
              );
              let completed = false;

              const done = Effect.runPromise(session.awaitCompletion).then(() => {
                completed = true;
              });

              await entered.promise;
              const before = (await Effect.runPromise(session.status)).state;
              const completedEarly = completed;

              const available = parseFeed(await readFile(join(outputPath, "Fiction", "SciFi", "feed.xml"), "utf8")).entries.map(
                (entry) => entry.title,
              );

              const previousParent = parseFeed(await readFile(parentFeed, "utf8")).entries.map((entry) => entry.summary);
              release.open();
              await done;

              return {
                before,
                completedEarly,
                available,
                previousParent,
                finalParent: parseFeed(await readFile(parentFeed, "utf8")).entries.map((entry) => entry.summary),
                after: (await Effect.runPromise(session.status)).state,
              };
            }),
          ),
        ),
      ),
    );

    // #then earlier results are usable but required downstream work remains part of completion
    expect(observation).toEqual({
      before: "working",
      completedEarly: false,
      available: ["Test Book"],
      previousParent: [undefined],
      finalParent: ["📚 1"],
      after: "complete",
    });
  } finally {
    release.open();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending duplicate refreshes combine while an active equivalent refresh retains a follow-up publication", async () => {
  // #given a real folder feed and a first refresh held at its filesystem write
  const { root, sourcePath, outputPath, deps } = await tree();
  await mkdir(join(sourcePath, "Fiction"));
  await copyFile(join(fixtures, "Test Book - Test Author.epub"), join(sourcePath, "Fiction", "Book.epub"));
  const entered = gate();
  const release = gate();
  const ancient = new Date("2020-01-01T00:00:00Z");
  const leafFeed = join(outputPath, "Fiction", "feed.xml");
  let holdNext = false;

  const heldDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      atomicWrite: async (path: string, content: string) => {
        if (holdNext && path === leafFeed) {
          holdNext = false;
          entered.open();
          await release.promise;
          await deps.fs.atomicWrite(path, content);
          await utimes(path, ancient, ancient);

          return;
        }

        await deps.fs.atomicWrite(path, content);
      },
    },
  };

  try {
    const observation = await Effect.runPromise(
      Effect.scoped(
        openEngineCatalogue(heldDeps).pipe(
          Effect.flatMap((session) =>
            io(async () => {
              holdNext = true;
              const refresh = CatalogueEvent.FolderMetaSyncRequested({ path: join(outputPath, "Fiction") });
              await Effect.runPromise(session.submit([refresh]));
              await entered.promise;
              // #when repeated equivalent requests arrive while refresh is active
              await Effect.runPromise(session.submit([refresh, refresh, refresh]));
              const status = await Effect.runPromise(session.status);
              release.open();
              await Effect.runPromise(session.awaitCompletion);

              return {
                before: status.state,
                pending: status.pending,
                followedUp: (await stat(leafFeed)).mtimeMs !== ancient.getTime(),
                titles: parseFeed(await readFile(leafFeed, "utf8")).entries.map((entry) => entry.title),
                after: (await Effect.runPromise(session.status)).state,
              };
            }),
          ),
        ),
      ),
    );

    // #then one pending follow-up replaces the first refresh's dated real publication
    expect(observation).toEqual({ before: "working", pending: 1, followedUp: true, titles: ["Test Book"], after: "complete" });
  } finally {
    release.open();
    await rm(root, { recursive: true, force: true });
  }
});
