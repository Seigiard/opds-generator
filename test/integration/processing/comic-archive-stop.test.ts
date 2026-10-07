/**
 * Stopping the real Effect processor while comic extraction runs archive work.
 *
 * The production processor, `bookSync`, format registry, comic extractor, archive dispatch, command owner and
 * RAR extraction stay on the exercised path. Shell cases replace only the 7z/TAR read executables, by scripts that
 * report their PID and stdout file and then sleep. The RAR case holds only the read of the extracted file.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildContext, type HandlerDeps } from "../../../src/context.ts";
import { createEffectCatalogueProcessor } from "../../../src/processing/catalogue-processor-effect.ts";
import { bookSyncEffect } from "../../../src/processing/handlers/book-sync-effect.ts";
import { installHangingCommands, isAlive, waitForHangingChildren } from "../../helpers/hanging-command.ts";
import { FIXTURES_DIR, SAMPLE_IMAGE_SHA256, SAMPLE_IMAGES, buildComic, sampleImage, sha256 } from "../../helpers/comic-archives.ts";

const STOP_LIMIT_MS = 5000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** A catalogue with a previous entry for `name`, and a running processor that has been asked to sync it. */
async function startSync(root: string, name: string, source: string) {
  const filesPath = join(root, "files");
  const dataPath = join(root, "data");
  const bookData = join(dataPath, name);
  await mkdir(filesPath);
  await mkdir(bookData, { recursive: true });
  await copyFile(source, join(filesPath, name));
  await Bun.write(join(bookData, "entry.xml"), "previous entry");

  const errorLines: string[] = [];

  const consoleError = spyOn(console, "error").mockImplementation((line: string) => {
    errorLines.push(line);
  });

  cleanups.push(async () => consoleError.mockRestore());

  const { fs } = await buildContext();

  const deps: HandlerDeps = {
    config: { filesPath, dataPath, port: 3000, reconcileInterval: 1800 },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fs,
  };

  const processor = createEffectCatalogueProcessor({ deps, handlers: { BookCreated: bookSyncEffect } });
  const controller = new AbortController();
  const task = processor.start(controller.signal);
  processor.submit({ _tag: "BookCreated", parent: filesPath, name });

  const stop = async (beforeSettle: () => Promise<void> = async () => {}) => {
    const startedAt = performance.now();
    controller.abort(new Error("shutdown"));
    await beforeSettle();
    const outcome = await Promise.race([task.then(() => "stopped"), Bun.sleep(STOP_LIMIT_MS).then(() => "still running")]);
    console.log(`  ${name} stop: ${(performance.now() - startedAt).toFixed(1)} ms`);

    return outcome;
  };

  const published = async () => ({
    active: processor.status().active,
    entry: await Bun.file(join(bookData, "entry.xml")).text(),
    linkExists: await exists(join(bookData, name)),
    failureLogs: errorLines.filter((line) => line.includes("Handler failed")),
  });

  return { stop, published, task };
}

interface ReadObservation {
  beforeRelease: string;
  extracted: string | null;
}

const UNCHANGED = { active: null, entry: "previous entry", linkExists: false, failureLogs: [] };

describe("Stopping during comic archive extraction", () => {
  test.each([
    { type: "cbt" as const, command: "tar", isRead: (command: readonly string[]) => command[1] === "-xOf" },
    { type: "cb7" as const, command: "7zz", isRead: (command: readonly string[]) => command[1] === "e" },
  ])(
    "$command: kills both running optional-metadata reads and keeps the previous entry",
    async ({ type, command, isRead }) => {
      // #given a comic with ComicInfo and CoMet whose two metadata reads are both running
      const root = await mkdtemp(join(tmpdir(), "opds-comic-stop-"));
      const hangRoot = join(root, "hang");
      await mkdir(hangRoot);

      const archive = await buildComic(root, `source.${type}`, type, {
        "ComicInfo.xml": "<ComicInfo><Title>New</Title></ComicInfo>",
        "CoMet.xml": "<comet><title>New</title></comet>",
        [SAMPLE_IMAGES[0]!]: await sampleImage(0),
      });

      const { restore } = await installHangingCommands([command], hangRoot, isRead);
      let pids: number[] = [];
      cleanups.push(async () => {
        restore();

        for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
        await rm(root, { recursive: true, force: true });
      });

      const sync = await startSync(root, `Stop.${type}`, archive);
      const children = await waitForHangingChildren(hangRoot, command, 2);
      pids = children.map((child) => child.pid);

      // #when the processor stops
      const stop = await sync.stop();

      // #then both reads are gone with their outputs, and nothing was published
      expect({
        stop,
        childrenAlive: children.map((child) => isAlive(child.pid)),
        outputsExist: await Promise.all(children.map((child) => exists(dirname(child.output)))),
        ...(await sync.published()),
      }).toEqual({ stop: "stopped", childrenAlive: [false, false], outputsExist: [false, false], ...UNCHANGED });
    },
    20_000,
  );

  test("RAR: the stop waits for the read of the extracted cover, then removes its directory and keeps the previous entry", async () => {
    // #given a CBR whose cover was extracted natively and whose extracted file is being read
    const root = await mkdtemp(join(tmpdir(), "opds-comic-stop-"));
    const originalFile = Bun.file.bind(Bun);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<string>();

    // SAFETY: the mock takes the string-path overload the RAR read calls and returns the real BunFile for it.
    const fileSpy = spyOn(Bun, "file").mockImplementation(((target: string, options?: BlobPropertyBag) => {
      const file = originalFile(target, options);

      if (!(target.includes("/rar-") && target.endsWith(`/${SAMPLE_IMAGES[0]}`))) return file;

      const arrayBuffer = file.arrayBuffer.bind(file);
      file.arrayBuffer = () => {
        markStarted(target);

        return gate.then(arrayBuffer);
      };

      return file;
    }) as typeof Bun.file);

    cleanups.push(async () => {
      release();
      fileSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    });

    const sync = await startSync(root, "Stop.cbr", join(FIXTURES_DIR, "bobby_make_believe_sample.cbr"));
    const extracted = await started;
    const duringRead: ReadObservation = { beforeRelease: "", extracted: null };

    // #when the processor stops during the read, which is then released
    const stop = await sync.stop(async () => {
      duringRead.beforeRelease = await Promise.race([sync.task.then(() => "stopped"), Bun.sleep(100).then(() => "waiting")]);
      duringRead.extracted = sha256(Buffer.from(await originalFile(extracted).arrayBuffer()));
      release();
    });

    // #then the extracted file was there during the read, its directory is gone, and nothing was published
    expect({
      ...duringRead,
      stop,
      directoryExists: await exists(dirname(extracted)),
      ...(await sync.published()),
    }).toEqual({
      beforeRelease: "waiting",
      extracted: SAMPLE_IMAGE_SHA256[0],
      stop: "stopped",
      directoryExists: false,
      ...UNCHANGED,
    });
  }, 20_000);
});
