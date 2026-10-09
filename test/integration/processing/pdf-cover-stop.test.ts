/**
 * Stopping the production lifecycle while PDF extraction waits on a running cover command.
 *
 * The production lifecycle, `bookSync`, format registry, PDF extractor and command owner stay on the
 * exercised path. Only the `pdftoppm` executable is replaced, by a script that reports its PID and then
 * sleeps, so the test can interrupt at a known point. Bun resolves commands against the PATH it started
 * with, so the spawn spy maps the name to the script and leaves every other command and option alone.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext, type HandlerDeps } from "../../../src/context.ts";
import { startProductionLifecycle } from "../../helpers/production-lifecycle.ts";

const SOURCE_PDF = join(import.meta.dir, "../../../files/test/Test Book - Test Author.pdf");

const STOP_LIMIT_MS = 5000;

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

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const file = Bun.file(path);

    if (await file.exists()) {
      const text = (await file.text()).trim();

      if (text) return Number(text);
    }

    await Bun.sleep(10);
  }

  throw new Error("cover command did not start");
}

async function installHangingPdftoppm(root: string): Promise<{ ready: string; restore: () => void }> {
  const script = join(root, "pdftoppm");
  const ready = join(root, "pdftoppm.pid");
  await Bun.write(script, `#!/bin/sh\necho $$ > "${ready}.tmp"\nmv "${ready}.tmp" "${ready}"\nexec sleep 600\n`);
  await chmod(script, 0o755);

  const originalSpawn = Bun.spawn.bind(Bun);

  const spawnSpy = spyOn(Bun, "spawn").mockImplementation((command: any, options?: any) =>
    originalSpawn(command[0] === "pdftoppm" ? [script, ...command.slice(1)] : command, options),
  );

  return { ready, restore: () => spawnSpy.mockRestore() };
}

describe("Stopping during PDF cover extraction", () => {
  test("kills the running cover command and keeps the previous entry without a download link", async () => {
    // #given a PDF whose previous entry exists and whose cover command is running
    const root = await mkdtemp(join(tmpdir(), "opds-pdf-stop-"));
    const filesPath = join(root, "files");
    const dataPath = join(root, "data");
    const bookData = join(dataPath, "Stop.pdf");
    await mkdir(filesPath);
    await mkdir(bookData, { recursive: true });
    await copyFile(SOURCE_PDF, join(filesPath, "Stop.pdf"));
    await Bun.write(join(bookData, "entry.xml"), "previous entry");
    const { ready, restore } = await installHangingPdftoppm(root);
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
    pid = await waitForPid(ready);

    // #when the lifecycle stops
    const startedAt = performance.now();
    controller.abort(new Error("shutdown"));
    const stop = await Promise.race([task.then(() => "stopped"), Bun.sleep(STOP_LIMIT_MS).then(() => "still running")]);
    console.log(`  PDF cover stop: ${(performance.now() - startedAt).toFixed(1)} ms`);

    // #then the child is gone, nothing is active, the old entry stays and no failure was logged
    expect({
      stop,
      childAlive: isAlive(pid),
      active: await lifecycle.active(),
      entry: await Bun.file(join(bookData, "entry.xml")).text(),
      linkExists: await Bun.file(join(bookData, "Stop.pdf")).exists(),
      failureLogs: errorLines.filter((line) => line.includes("Handler failed")),
    }).toEqual({ stop: "stopped", childAlive: false, active: null, entry: "previous entry", linkExists: false, failureLogs: [] });
  }, 20_000);
});
