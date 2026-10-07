/**
 * The real server process under SIGTERM (issue #15 check 4) and its resync HTTP answers (check 2).
 * Runs inside the test container, where the app may run under bun.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_DIR = join(import.meta.dir, "../../../files/test");

const SERVER = join(import.meta.dir, "../../../src/server.ts");

const DEADLINE_MS = 8_000;

let nextPort = 39_000 + Math.floor(Math.random() * 500);

const cleanups: Array<() => Promise<void>> = [];

async function launch() {
  const root = await mkdtemp(join(tmpdir(), "opds-shutdown-"));
  const files = join(root, "files");
  await mkdir(join(files, "Fiction"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });

  // Enough books that the first scan and the queue are still busy when the signal arrives.
  for (let i = 0; i < 30; i++) await copyFile(join(FIXTURE_DIR, "Test Book - Test Author.epub"), join(files, "Fiction", `Book ${i}.epub`));

  const port = nextPort++;

  const child = Bun.spawn(["bun", SERVER], {
    env: { ...process.env, FILES: files, DATA: join(root, "data"), PORT: String(port), LOG_LEVEL: "info", RECONCILE_INTERVAL: "0" },
    stdout: "pipe",
    stderr: "ignore",
  });

  cleanups.push(async () => {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const up = await fetch(`${base}/status`).then(
      (r) => r.ok,
      () => false,
    );

    if (up) return { child, base };
    await Bun.sleep(50);
  }

  throw new Error("server did not start");
}

async function terminate(child: ReturnType<typeof Bun.spawn>) {
  const started = Date.now();
  child.kill("SIGTERM");
  const code = await child.exited;

  return { code, ms: Date.now() - started };
}

describe("server shutdown and resync answers", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  test("SIGTERM during the initial scan exits with code 0 before the deadline", async () => {
    // #given a server that has just started its initial scan
    const { child } = await launch();
    // #when
    const outcome = await terminate(child);
    // #then
    expect(outcome.code).toBe(0);
    expect(outcome.ms).toBeLessThan(DEADLINE_MS);
  });

  test("SIGTERM during a resync exits with code 0 before the deadline", async () => {
    // #given a server that accepted a forced resync
    const { child, base } = await launch();
    const answer = await fetch(`${base}/resync?force=1`, { method: "POST" });
    // #when
    const outcome = await terminate(child);
    // #then
    expect({ status: answer.status, code: outcome.code }).toEqual({ status: 202, code: 0 });
    expect(outcome.ms).toBeLessThan(DEADLINE_MS);
  });

  test("a missing books directory fails the initial scan and exits with code 1 before the deadline", async () => {
    // #given a server whose books directory does not exist
    const started = Date.now();

    const child = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        FILES: join(tmpdir(), "opds-no-such-books"),
        DATA: await mkdtemp(join(tmpdir(), "opds-data-")),
        PORT: String(nextPort++),
        RECONCILE_INTERVAL: "0",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    cleanups.push(async () => {
      child.kill("SIGKILL");
    });

    // #when
    const code = await child.exited;
    // #then
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS + 5_000);
  });

  test("resyncs are always answered 202, never 409, however many arrive", async () => {
    // #given a server working on its first scan and queue
    const { child, base } = await launch();

    // #when several resyncs arrive back to back, forced or not
    const statuses = await Promise.all(
      [false, true, false, true].map((force) =>
        fetch(`${base}/resync${force ? "?force=1" : ""}`, { method: "POST" }).then((r) => r.status),
      ),
    );

    await terminate(child);
    // #then
    expect(statuses).toEqual([202, 202, 202, 202]);
  });
});
