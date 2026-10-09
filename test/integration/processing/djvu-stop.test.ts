/**
 * Stopping DJVU extraction at each owned point: the two metadata commands, the cover command, and the native
 * TIFF conversion.
 *
 * The production lifecycle, `bookSync`, format registry, DJVU extractor and command owner stay on the exercised
 * path. A stage under test is held at a known point: a command by a script that reports its PID and sleeps
 * (Bun resolves commands against the PATH it started with, so a spawn spy maps the name to the script), and the
 * native conversion by a barrier around sharp's `toBuffer` that still runs the real conversion once released.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import sharp, { type Sharp } from "sharp";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildContext, type HandlerDeps } from "../../../src/context.ts";
import { djvuExtractorRegistration } from "../../../src/formats/djvu.ts";
import { startProductionLifecycle } from "../../helpers/production-lifecycle.ts";

const SOURCE_DJVU = join(import.meta.dir, "../../../files/test/Test Book - Test Author.djvu");

const STOP_LIMIT_MS = 5000;

// Long enough for an unowned conversion to let the lifecycle stop first; an owned one cannot stop before release.
const EARLY_STOP_WINDOW_MS = 300;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function waitForPids(directory: string, count: number): Promise<number[]> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".pid"));

    if (names.length >= count) return names.map((name) => Number(name.slice(0, -".pid".length)));

    await Bun.sleep(10);
  }

  throw new Error(`${count} commands did not start`);
}

interface Fixture {
  readonly root: string;
  readonly filesPath: string;
  readonly bookData: string;
  readonly pidDirectory: string;
  readonly tiffPaths: string[];
  readonly pids: number[];
}

/** A DJVU book with a previous entry. Commands named in `hanging` run a PID-reporting sleeper instead. */
async function setUp(hanging: readonly string[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "opds-djvu-stop-"));
  const filesPath = join(root, "files");
  const bookData = join(root, "data", "Stop.djvu");
  const pidDirectory = join(root, "pids");
  await mkdir(filesPath);
  await mkdir(pidDirectory);
  await mkdir(bookData, { recursive: true });
  await copyFile(SOURCE_DJVU, join(filesPath, "Stop.djvu"));
  await Bun.write(join(bookData, "entry.xml"), "previous entry");

  const script = join(root, "sleeper");
  await Bun.write(
    script,
    `#!/bin/sh\necho $$ > "${pidDirectory}/$$.tmp"\nmv "${pidDirectory}/$$.tmp" "${pidDirectory}/$$.pid"\nexec sleep 600\n`,
  );
  await chmod(script, 0o755);

  const tiffPaths: string[] = [];
  const pids: number[] = [];
  const originalSpawn = Bun.spawn.bind(Bun);

  const spawnSpy = spyOn(Bun, "spawn").mockImplementation((command: any, options?: any) => {
    if (command[0] === "ddjvu") tiffPaths.push(command[4]);

    return originalSpawn(hanging.includes(command[0]) ? [script, ...command.slice(1)] : command, options);
  });

  cleanups.push(async () => {
    spawnSpy.mockRestore();

    for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  return { root, filesPath, bookData, pidDirectory, tiffPaths, pids };
}

async function startProcessor(fixture: Fixture, failureLogs: string[] = []) {
  const { fs } = await buildContext();

  const deps: HandlerDeps = {
    config: { filesPath: fixture.filesPath, dataPath: join(fixture.root, "data"), port: 3000, reconcileInterval: 1800 },
    logger: { info: () => {}, warn: () => {}, error: (_tag, message) => failureLogs.push(message), debug: () => {} },
    fs,
  };

  return startProductionLifecycle(deps);
}

async function publishedState(fixture: Fixture) {
  return {
    entry: await Bun.file(join(fixture.bookData, "entry.xml")).text(),
    linkExists: await Bun.file(join(fixture.bookData, "Stop.djvu")).exists(),
    coverExists: await Bun.file(join(fixture.bookData, "cover.jpg")).exists(),
  };
}

const UNTOUCHED = { entry: "previous entry", linkExists: false, coverExists: false };

function captureHandlerFailures(): string[] {
  return [];
}

describe("Stopping DJVU extraction", () => {
  test("interruption during the metadata commands settles both children and is not an extraction failure", async () => {
    // #given both djvused commands running
    const fixture = await setUp(["djvused"]);
    const controller = new AbortController();

    const task = Effect.runPromiseExit(djvuExtractorRegistration.extract(join(fixture.filesPath, "Stop.djvu")), {
      signal: controller.signal,
    });

    fixture.pids.push(...(await waitForPids(fixture.pidDirectory, 2)));

    // #when the extraction is interrupted
    controller.abort();
    const exit = await task;

    // #then the extraction ended by interruption, after both children exited
    expect({ interruptedOnly: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), alive: fixture.pids.map(isAlive) }).toEqual({
      interruptedOnly: true,
      alive: [false, false],
    });
  }, 20_000);

  test("stopping during the cover command kills the child, removes the page directory and keeps the previous entry", async () => {
    // #given real metadata commands and a running cover command
    const fixture = await setUp(["ddjvu"]);
    const failures = captureHandlerFailures();
    const run = await startProcessor(fixture, failures);
    const { controller, task } = run;
    fixture.pids.push(...(await waitForPids(fixture.pidDirectory, 1)));

    // #when the lifecycle stops
    const startedAt = performance.now();
    controller.abort(new Error("shutdown"));
    const stop = await Promise.race([task.then(() => "stopped"), Bun.sleep(STOP_LIMIT_MS).then(() => "still running")]);
    console.log(`  DJVU cover command stop: ${(performance.now() - startedAt).toFixed(1)} ms`);

    // #then
    expect({
      stop,
      childAlive: isAlive(fixture.pids[0]!),
      pageDirectoryExists: existsSync(dirname(fixture.tiffPaths[0]!)),
      active: await run.active(),
      ...(await publishedState(fixture)),
      failureLogs: failures.filter((line) => line.includes("Handler failed")),
    }).toEqual({ stop: "stopped", childAlive: false, pageDirectoryExists: false, active: null, ...UNTOUCHED, failureLogs: [] });
  }, 20_000);

  test("stopping during native conversion waits for it with the page image present, then removes the page directory", async () => {
    // #given the real cover command finished and the native conversion held at a barrier
    const fixture = await setUp([]);
    const failures = captureHandlerFailures();
    const nativeStarted = Promise.withResolvers<void>();
    const nativeRelease = Promise.withResolvers<void>();
    const nativeUse = { imagePresentAtRead: false, converted: false, ended: false };
    const originalToBuffer = sharp.prototype.toBuffer;

    const toBufferSpy = spyOn(sharp.prototype, "toBuffer").mockImplementation(async function (this: Sharp) {
      nativeStarted.resolve();
      await nativeRelease.promise;
      nativeUse.imagePresentAtRead = existsSync(fixture.tiffPaths[0]!);

      try {
        const data: Buffer = await originalToBuffer.call(this);
        nativeUse.converted = data.byteLength > 0;

        return data;
      } finally {
        nativeUse.ended = true;
      }
    });

    cleanups.push(async () => toBufferSpy.mockRestore());
    const run = await startProcessor(fixture, failures);
    const { controller, task } = run;
    await nativeStarted.promise;

    // #when the lifecycle stops while the native work runs
    controller.abort(new Error("shutdown"));
    const stoppedEarly = await Promise.race([task.then(() => true), Bun.sleep(EARLY_STOP_WINDOW_MS).then(() => false)]);
    nativeRelease.resolve();
    const startedAt = performance.now();
    await task;
    console.log(`  DJVU native conversion stop after release: ${(performance.now() - startedAt).toFixed(1)} ms`);

    // #then the lifecycle stopped only after the native work ended, which read the page image before removal
    expect({
      stoppedEarly,
      nativeUse,
      pageDirectoryExists: existsSync(dirname(fixture.tiffPaths[0]!)),
      active: await run.active(),
      ...(await publishedState(fixture)),
      failureLogs: failures.filter((line) => line.includes("Handler failed")),
    }).toEqual({
      stoppedEarly: false,
      nativeUse: { imagePresentAtRead: true, converted: true, ended: true },
      pageDirectoryExists: false,
      active: null,
      ...UNTOUCHED,
      failureLogs: [],
    });
  }, 20_000);
});
