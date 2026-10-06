import { describe, test, expect } from "bun:test";
import { spawnWithTimeout, spawnWithTimeoutText, withTemporaryDirectory } from "../../../src/utils/process.ts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3000;

  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) throw new Error(`Child did not become ready: ${path}`);
    await Bun.sleep(10);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

describe("spawnWithTimeout", () => {
  test("a missing executable releases acquired descriptors", async () => {
    // #given
    const before = (await readdir("/proc/self/fd")).length;
    // #when
    const outcomes: string[] = [];

    for (let index = 0; index < 4; index++) {
      outcomes.push(
        await spawnWithTimeout({ command: ["/nonexistent-opds-command"] }).then(
          () => "completed",
          () => "failed",
        ),
      );
    }

    // #then
    expect({ outcomes, descriptorGrowth: (await readdir("/proc/self/fd")).length - before }).toEqual({
      outcomes: ["failed", "failed", "failed", "failed"],
      descriptorGrowth: 0,
    });
  });

  test("cancellation reaps a child that ignores SIGTERM and releases its output", async () => {
    // #given
    const directory = await mkdtemp(join(tmpdir(), "command-cancellation-"));
    const ready = join(directory, "ready.json");
    const controller = new AbortController();
    const reason = new Error("shutdown");
    let pid: number | undefined;

    const task = spawnWithTimeout({
      command: [
        process.execPath,
        "-e",
        `
        const { writeFileSync, readlinkSync } = require("node:fs");
        process.on("SIGTERM", () => {});
        writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, output: readlinkSync("/proc/self/fd/1") }));
        setInterval(() => {}, 100);
      `,
      ],
      timeout: 3000,
      signal: controller.signal,
    }).then(
      (result) => ({ result }),
      (error: Error) => ({ error }),
    );

    try {
      await waitForFile(ready);
      const child: { pid: number; output: string } = await Bun.file(ready).json();
      pid = child.pid;
      // #when
      controller.abort(reason);
      const outcome = await task;
      // #then
      expect({ ...outcome, alive: isAlive(child.pid), outputExists: await Bun.file(child.output).exists() }).toEqual({
        error: reason,
        alive: false,
        outputExists: false,
      });
    } finally {
      controller.abort(reason);

      if (pid !== undefined && isAlive(pid)) process.kill(pid, "SIGKILL");
      await task;
      await rm(directory, { recursive: true, force: true });
    }
  }, 8000);

  test("returns stdout for successful command", async () => {
    const result = await spawnWithTimeoutText({
      command: ["echo", "hello"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("returns non-zero exit code for failed command", async () => {
    const result = await spawnWithTimeoutText({
      command: ["false"],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("times out for long-running command", async () => {
    const result = await spawnWithTimeout({
      command: ["sleep", "10"],
      timeout: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  test("returns binary data correctly", async () => {
    const result = await spawnWithTimeout({
      command: ["printf", "\\x00\\x01\\x02"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.byteLength).toBe(3);
  });

  test("handles command with multiple arguments", async () => {
    const result = await spawnWithTimeoutText({
      command: ["echo", "-n", "test"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test");
  });

  test("returns non-zero exit code for failed command with ignored stderr", async () => {
    const result = await spawnWithTimeout({
      command: ["ls", "/nonexistent-path-12345"],
    });

    expect(result.exitCode).not.toBe(0);
  });
});

describe("withTemporaryDirectory", () => {
  test("keeps temporary input alive until an uncancellable reader settles", async () => {
    // #given
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const ready = Promise.withResolvers<string>();
    const finished = Promise.withResolvers<void>();
    let consumed = "";

    const task = withTemporaryDirectory(
      "temporary-reader-",
      async (directory) => {
        const file = join(directory, "input");
        await Bun.write(file, "reader input");
        ready.resolve(directory);

        try {
          await Bun.sleep(50);
          consumed = await Bun.file(file).text();
        } finally {
          finished.resolve();
        }
      },
      controller.signal,
    ).then(
      () => "completed",
      (error) => error,
    );

    const directory = await ready.promise;
    // #when
    controller.abort(reason);
    const outcome = await task;
    await finished.promise;
    // #then
    expect({ outcome, consumed, directoryExists: existsSync(directory) }).toEqual({
      outcome: reason,
      consumed: "reader input",
      directoryExists: false,
    });
  });

  test("releases its directory after callback failure", async () => {
    // #given
    let directory = "";
    const reason = new Error("reader failed");

    // #when
    const outcome = await withTemporaryDirectory("temporary-failure-", async (path) => {
      directory = path;
      await Bun.write(join(path, "input"), "reader input");
      throw reason;
    }).then(
      () => "completed",
      (error: Error) => error,
    );

    // #then
    expect({ outcome, directoryExists: existsSync(directory) }).toEqual({ outcome: reason, directoryExists: false });
  });
});

describe("spawnWithTimeoutText", () => {
  test("decodes stdout as text", async () => {
    const result = await spawnWithTimeoutText({
      command: ["printf", "hello world"],
    });

    expect(result.stdout).toBe("hello world");
    expect(result.timedOut).toBe(false);
  });
});
