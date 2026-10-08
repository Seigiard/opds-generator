import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readlink, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildContext } from "../../../src/context.ts";
import { createLiveEngineLifecycle } from "../../../src/lifecycle/live-engine-lifecycle.ts";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import { isAlive, waitForHangingChild } from "../../helpers/hanging-command.ts";

const fixture = join(import.meta.dir, "../../../files/test/Test Book - Test Author.epub");

const serverPath = join(import.meta.dir, "../../../src/server.ts");

let nextPort = 40550 + Math.floor(Math.random() * 100);

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;

  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Server did not reach the expected public state");
    await Bun.sleep(10);
  }
}

for (const phase of ["initial", "resync"] as const) {
  test(`shared server SIGTERM during ${phase} extraction joins the actual child and restart repairs publications`, async () => {
    // #given a real previous EPUB catalogue and an executable that holds the actual ZIP read
    const root = await mkdtemp(join(tmpdir(), "opds-engine-signal-"));
    const filesPath = join(root, "source");
    const dataPath = join(root, "output");
    const bin = join(root, "bin");
    const ready = join(root, "unzip.json");
    await mkdir(filesPath);
    await mkdir(bin);
    await copyFile(fixture, join(filesPath, "Book.epub"));
    const ctx = await buildContext();
    const runtime = createLiveEngineLifecycle({ ...ctx, config: { ...ctx.config, filesPath, dataPath, reconcileInterval: 0 } });
    await runtime.start();
    await runtime.stop();
    const entry = join(dataPath, "Book.epub", "entry.xml");
    const previous = await readFile(entry, "utf8");
    const ancient = new Date("2020-01-01T00:00:00Z");
    await utimes(entry, ancient, ancient);

    if (phase === "initial") await utimes(join(filesPath, "Book.epub"), new Date(), new Date());
    await Bun.write(
      join(bin, "unzip"),
      `#!/bin/sh\nprintf '{"pid":%s,"output":"%s"}' $$ "$(readlink /proc/$$/fd/1)" > "${ready}.tmp"\nmv "${ready}.tmp" "${ready}"\nexec sleep 600\n`,
    );
    await chmod(join(bin, "unzip"), 0o755);
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;

    const env = {
      ...process.env,
      FILES: filesPath,
      DATA: dataPath,
      PORT: String(port),
      LOG_LEVEL: "info",
      RECONCILE_INTERVAL: "0",
      SYNC_ENGINE: "shared",
    };

    const child = Bun.spawn(["bun", serverPath], { env: { ...env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    let commandPid: number | undefined;
    let restarted: ReturnType<typeof Bun.spawn> | undefined;

    try {
      await waitFor(async () =>
        fetch(`${base}/status`).then(
          (response) => response.ok,
          () => false,
        ),
      );

      if (phase === "resync") {
        const admission = await fetch(`${base}/resync?force=1`, { method: "POST" });
        expect(admission.status).toBe(202);
      }

      const command = await waitForHangingChild(ready);
      commandPid = command.pid;
      const before = await readFile(entry, "utf8");
      // #when the real server receives SIGTERM while it owns an extraction process and stdout directory
      const start = performance.now();
      child.kill("SIGTERM");
      const exit = await child.exited;
      const elapsed = performance.now() - start;
      const logs = `${await stdout}\n${await stderr}`;

      const stopped = {
        exit,
        before,
        previousKept: (await readFile(entry, "utf8")) === previous,
        childAlive: isAlive(command.pid),
        outputExists: await stat(dirname(command.output)).then(
          () => true,
          () => false,
        ),
        link: await readlink(join(dataPath, "Book.epub", "Book.epub")),
        ordinaryFailure: /Handler failed|ExtractionFailed|Initial scan failed|Processor failed|Shutdown deadline reached/.test(logs),
        deadlineMet: elapsed < 8000,
      };

      // Startup has no saved queue to restore; its real scan must rediscover unfinished work.
      restarted = Bun.spawn(["bun", serverPath], { env, stdout: "ignore", stderr: "ignore" });
      await waitFor(async () => {
        const response = await fetch(`${base}/status`).catch(() => undefined);

        return response?.ok === true && (await response.json()).state === "complete";
      });
      const repaired = (await stat(entry)).mtimeMs !== ancient.getTime();
      const feed = parseFeed(await readFile(join(dataPath, "feed.xml"), "utf8"));
      restarted.kill("SIGTERM");
      const restartExit = await restarted.exited;
      // #then SIGTERM joined cleanup, retained valid output and a new process completed repeatable real publication
      expect({
        stopped,
        repaired,
        restartExit,
        titles: feed.entries.map((book) => book.title),
        downloadMatches: (await readFile(join(dataPath, "Book.epub", "Book.epub"))).equals(await readFile(fixture)),
      }).toEqual({
        stopped: {
          exit: 0,
          before: previous,
          previousKept: true,
          childAlive: false,
          outputExists: false,
          link: join(filesPath, "Book.epub"),
          ordinaryFailure: false,
          deadlineMet: true,
        },
        repaired: true,
        restartExit: 0,
        titles: ["Test Book"],
        downloadMatches: true,
      });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;

      if (restarted) {
        if (restarted.exitCode === null) restarted.kill("SIGKILL");
        await restarted.exited;
      }

      if (commandPid !== undefined && isAlive(commandPid)) process.kill(commandPid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 25000);
}
