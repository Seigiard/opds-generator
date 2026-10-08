import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { acquireOutputTree, OutputOwnershipFailed } from "@seigiard/sync-engine";
import { buildContext } from "../../../src/context.ts";
import { createInitialEngineScanner, initialEngineCatalogue } from "../../../src/lifecycle/initial-engine-catalogue.ts";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import { createLifecycle, systemClock } from "../../../src/lifecycle/lifecycle.ts";
import { createDiskScanner } from "../../../src/lifecycle/disk-scanner.ts";
import { createEffectCatalogueProcessor } from "../../../src/processing/catalogue-processor-effect.ts";
import { bookSyncEffect } from "../../../src/processing/handlers/book-sync-effect.ts";
import { folderSyncEffect } from "../../../src/processing/handlers/folder-sync-effect.ts";
import { folderMetaSyncEffect } from "../../../src/processing/handlers/folder-meta-sync-effect.ts";

function gate() {
  let open = () => {};

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

test("initial book publication waits for its required download target", async () => {
  // #given a real TXT source and a held download-link filesystem operation
  const root = await mkdtemp(join(tmpdir(), "opds-engine-target-"));
  const sourcePath = join(root, "source");
  const outputPath = join(root, "output");
  await mkdir(sourcePath);
  await Bun.write(join(sourcePath, "First Book.txt"), "Independent source bytes.\n");
  const ctx = await buildContext();
  const entered = gate();
  const release = gate();

  const deps = {
    ...ctx,
    config: { ...ctx.config, filesPath: sourcePath, dataPath: outputPath },
    fs: {
      ...ctx.fs,
      symlink: async (target: string, path: string) => {
        entered.open();
        await release.promise;
        await ctx.fs.symlink(target, path);
      },
    },
  };

  const task = Effect.runPromise(initialEngineCatalogue(deps));

  try {
    // #when publication has reached the required-target boundary
    await entered.promise;
    const prematureEntry = await Bun.file(join(outputPath, "First Book.txt", "entry.xml")).exists();
    const prematureFeed = await Bun.file(join(outputPath, "feed.xml")).exists();
    release.open();
    await task;
    // #then no new reference preceded its target and the final download is readable
    expect({
      prematureEntry,
      prematureFeed,
      download: await readFile(join(outputPath, "First Book.txt", "First Book.txt"), "utf8"),
    }).toEqual({ prematureEntry: false, prematureFeed: false, download: "Independent source bytes.\n" });
  } finally {
    release.open();
    await task;
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged engine publishes a TXT book, its root catalogue and a working download", async () => {
  // #given a real source and the production handler dependencies
  const root = await mkdtemp(join(tmpdir(), "opds-engine-"));
  const sourcePath = join(root, "source");
  const outputPath = join(root, "output");
  await mkdir(sourcePath);
  await Bun.write(join(sourcePath, "First Book.txt"), "Independent source bytes.\n");
  const ctx = await buildContext();
  const deps = { ...ctx, config: { ...ctx.config, filesPath: sourcePath, dataPath: outputPath, reconcileInterval: 0 } };

  const processor = createEffectCatalogueProcessor({
    deps,
    handlers: { BookCreated: bookSyncEffect, FolderCreated: folderSyncEffect, FolderMetaSyncRequested: folderMetaSyncEffect },
  });

  const lifecycle = createLifecycle({
    scanner: createInitialEngineScanner(deps),
    processor,
    clock: systemClock,
    reconcileIntervalSeconds: 0,
  });

  try {
    // #when the initial pass runs through the packaged public interface
    await lifecycle.start();
    // #then public artifacts and the download resolve to the independent example
    const feedFile = Bun.file(join(outputPath, "feed.xml"));
    const htmlFile = Bun.file(join(outputPath, "index.html"));
    const entryFile = Bun.file(join(outputPath, "First Book.txt", "entry.xml"));
    const feed = (await feedFile.exists()) ? parseFeed(await feedFile.text()) : null;
    const html = (await htmlFile.exists()) ? await htmlFile.text() : "";
    const entry = (await entryFile.exists()) ? parseFeed(`<feed>${await entryFile.text()}</feed>`).entries[0] : null;
    const download = join(outputPath, "First Book.txt", "First Book.txt");
    expect({
      titles: feed?.entries.map((item) => item.title) ?? [],
      entryTitle: entry?.title ?? null,
      acquisition: entry?.acquisitions?.[0]?.href ?? null,
      browserDownload: html.includes('href="/First%20Book.txt/First%20Book.txt"'),
      downloadTarget: (await Bun.file(download).exists()) ? await readlink(download) : null,
      downloadBytes: (await Bun.file(download).exists()) ? await readFile(download, "utf8") : null,
      sourceBytes: await readFile(join(sourcePath, "First Book.txt"), "utf8"),
    }).toEqual({
      titles: ["First Book"],
      entryTitle: "First Book",
      acquisition: "/First%20Book.txt/First%20Book.txt",
      browserDownload: true,
      downloadTarget: join(sourcePath, "First Book.txt"),
      downloadBytes: "Independent source bytes.\n",
      sourceBytes: "Independent source bytes.\n",
    });
  } finally {
    await lifecycle.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a resync during legacy lease acquisition cannot publish into another owner's output", async () => {
  // #given another composition owns the output before the legacy lifecycle starts
  const root = await mkdtemp(join(tmpdir(), "opds-engine-admission-"));
  const sourcePath = join(root, "source");
  const outputPath = join(root, "output");
  await mkdir(sourcePath);
  await Bun.write(join(sourcePath, "First Book.txt"), "Independent source bytes.\n");
  const release = await Effect.runPromise(acquireOutputTree(outputPath, join(outputPath, ".sync-engine")));
  const ctx = await buildContext();
  const deps = { ...ctx, config: { ...ctx.config, filesPath: sourcePath, dataPath: outputPath, reconcileInterval: 0 } };

  const processor = createEffectCatalogueProcessor({
    deps,
    handlers: { BookCreated: bookSyncEffect, FolderCreated: folderSyncEffect, FolderMetaSyncRequested: folderMetaSyncEffect },
  });

  const lifecycle = createLifecycle({
    scanner: createDiskScanner(deps.config),
    processor,
    clock: systemClock,
    reconcileIntervalSeconds: 0,
  });

  try {
    // #when startup is pending and a forced resync arrives before it owns output
    const start = lifecycle.start().then(
      () => "accepted",
      (error) => (error instanceof OutputOwnershipFailed ? "owned" : "other failure"),
    );

    const admission = lifecycle.requestScan({ kind: "resync", force: true });
    const acceptingWatcher = lifecycle.accepting();
    const outcome = await start;
    await lifecycle.stop();
    // #then the request stays queued and no competing publication starts
    expect({ outcome, admission, acceptingWatcher, feed: await Bun.file(join(outputPath, "feed.xml")).exists() }).toEqual({
      outcome: "owned",
      admission: "queued",
      acceptingWatcher: false,
      feed: false,
    });
  } finally {
    await lifecycle.stop();
    await release();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy ownership refuses a second composition until legacy stops", async () => {
  // #given the real legacy lifecycle has exclusive ownership of an output tree
  const root = await mkdtemp(join(tmpdir(), "opds-engine-owner-"));
  const sourcePath = join(root, "source");
  const outputPath = join(root, "output");
  await mkdir(sourcePath);
  await Bun.write(join(sourcePath, "First Book.txt"), "Independent source bytes.\n");
  const ctx = await buildContext();
  const deps = { ...ctx, config: { ...ctx.config, filesPath: sourcePath, dataPath: outputPath, reconcileInterval: 0 } };

  const processor = createEffectCatalogueProcessor({
    deps,
    handlers: { BookCreated: bookSyncEffect, FolderCreated: folderSyncEffect, FolderMetaSyncRequested: folderMetaSyncEffect },
  });

  const lifecycle = createLifecycle({
    scanner: createDiskScanner(deps.config),
    processor,
    clock: systemClock,
    reconcileIntervalSeconds: 0,
  });

  try {
    await lifecycle.start();

    // #when the engine tries to publish to that same tree, then retries after a stop
    const refused = await Effect.runPromise(
      initialEngineCatalogue(deps).pipe(
        Effect.as("accepted"),
        Effect.catch((error) => Effect.succeed(error instanceof OutputOwnershipFailed ? "owned" : "other failure")),
      ),
    );

    await lifecycle.stop();
    await Effect.runPromise(initialEngineCatalogue(deps));
    // #then refusal is specific to ownership, and the released tree is usable
    expect({ refused, titles: parseFeed(await Bun.file(join(outputPath, "feed.xml")).text()).entries.map((entry) => entry.title) }).toEqual(
      { refused: "owned", titles: ["First Book"] },
    );
  } finally {
    await lifecycle.stop();
    await rm(root, { recursive: true, force: true });
  }
});
