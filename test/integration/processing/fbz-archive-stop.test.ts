/**
 * Stopping the production lifecycle while FBZ extraction waits on a running archive command.
 *
 * The production lifecycle, `bookSync`, format registry, FB2 extractor, common archive dispatch and command owner
 * stay on the exercised path. Only the named executable is replaced, by a script that reports its PID and stdout
 * file and then sleeps, so the test can interrupt at a known point.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildContext, type HandlerDeps } from "../../../src/context.ts";
import { startProductionLifecycle } from "../../helpers/production-lifecycle.ts";
import { installHangingCommands, isAlive, waitForHangingChild } from "../../helpers/hanging-command.ts";

const SOURCE_FBZ = join(import.meta.dir, "../../../files/test/Test Book - Test Author.fbz");

const STOP_LIMIT_MS = 5000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Stopping during FBZ archive extraction", () => {
  test.each([
    ["entry listing", "zipinfo"],
    ["entry read", "unzip"],
  ])(
    "kills the running %s, releases its output and keeps the previous entry without a download link",
    async (_step, command) => {
      // #given an FBZ whose previous entry exists and whose archive command is running
      const root = await mkdtemp(join(tmpdir(), "opds-fbz-stop-"));
      const filesPath = join(root, "files");
      const dataPath = join(root, "data");
      const bookData = join(dataPath, "Stop.fbz");
      await mkdir(filesPath);
      await mkdir(bookData, { recursive: true });
      await copyFile(SOURCE_FBZ, join(filesPath, "Stop.fbz"));
      await Bun.write(join(bookData, "entry.xml"), "previous entry");
      const { ready, restore } = await installHangingCommands([command], root);
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
      const child = await waitForHangingChild(ready(command));
      pid = child.pid;

      // #when the lifecycle stops
      const startedAt = performance.now();
      controller.abort(new Error("shutdown"));
      const stop = await Promise.race([task.then(() => "stopped"), Bun.sleep(STOP_LIMIT_MS).then(() => "still running")]);
      console.log(`  FBZ ${command} stop: ${(performance.now() - startedAt).toFixed(1)} ms`);

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
        linkExists: await Bun.file(join(bookData, "Stop.fbz")).exists(),
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
    },
    20_000,
  );
});
