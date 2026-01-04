import { describe, test, expect } from "bun:test";
import { spawnWithTimeout, spawnWithTimeoutText } from "../../../src/utils/process.ts";

describe("spawnWithTimeout", () => {
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

  test("captures stderr", async () => {
    const result = await spawnWithTimeout({
      command: ["ls", "/nonexistent-path-12345"],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.byteLength).toBeGreaterThan(0);
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
