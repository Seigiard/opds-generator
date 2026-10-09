/**
 * Stopping the production lifecycle while EPUB extraction waits on a running ZIP read.
 *
 * The production lifecycle, `bookSync`, format registry, EPUB extractor, ZIP operations and command owner stay
 * on the exercised path. Only the `unzip` executable is replaced, by a script that reports its PID and stdout
 * file and then sleeps, so the test can interrupt at a known point.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildContext, type HandlerDeps } from "../../../src/context.ts";
import { startProductionLifecycle } from "../../helpers/production-lifecycle.ts";
import { installHangingCommands, isAlive, waitForHangingChild } from "../../helpers/hanging-command.ts";

const SOURCE_EPUB = join(import.meta.dir, "../../../files/test/Test Book - Test Author.epub");

const STOP_LIMIT_MS = 5000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Stopping during EPUB ZIP extraction", () => {
  test("kills the running ZIP read, releases its output and keeps the previous entry without a download link", async () => {
    // #given an EPUB whose previous entry exists and whose ZIP read is running
    const root = await mkdtemp(join(tmpdir(), "opds-epub-stop-"));
    const filesPath = join(root, "files");
    const dataPath = join(root, "data");
    const bookData = join(dataPath, "Stop.epub");
    await mkdir(filesPath);
    await mkdir(bookData, { recursive: true });
    await copyFile(SOURCE_EPUB, join(filesPath, "Stop.epub"));
    await Bun.write(join(bookData, "entry.xml"), "previous entry");
    const { ready, restore } = await installHangingCommands(["unzip"], root);
    let pid: number | undefined;

    const errorLines: string[] = [];

    cleanups.push(async () => {
      restore();

      if (pid !== undefined && isAlive(pid)) process.kill(pid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    });

    const { fs } = await buildContext();

    const deps: HandlerDeps = {
      config: { filesPath, dataPath, port: 3000, reconcileInterval: 1800 },
      logger: { info: () => {}, warn: () => {}, error: (_tag, message) => errorLines.push(message), debug: () => {} },
      fs,
    };

    const lifecycle = startProductionLifecycle(deps);
    const { controller, task } = lifecycle;
    const child = await waitForHangingChild(ready("unzip"));
    pid = child.pid;

    // #when the lifecycle stops
    const startedAt = performance.now();
    controller.abort(new Error("shutdown"));
    const stop = await Promise.race([task.then(() => "stopped"), Bun.sleep(STOP_LIMIT_MS).then(() => "still running")]);
    console.log(`  EPUB ZIP stop: ${(performance.now() - startedAt).toFixed(1)} ms`);

    // #then the child and its output are gone, nothing is active, the old entry stays and no failure was logged
    expect({
      stop,
      childAlive: isAlive(child.pid),
      outputDirectoryExists: await stat(dirname(child.output)).then(
        () => true,
        () => false,
      ),
      active: await lifecycle.active(),
      entry: await Bun.file(join(bookData, "entry.xml")).text(),
      linkExists: await Bun.file(join(bookData, "Stop.epub")).exists(),
      failureLogs: errorLines.filter((line) => line.includes("Handler failed")),
    }).toEqual({
      stop: "stopped",
      childAlive: false,
      outputDirectoryExists: false,
      active: null,
      entry: "previous entry",
      linkExists: false,
      failureLogs: [],
    });
  }, 20_000);
});
