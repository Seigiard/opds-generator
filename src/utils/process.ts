import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SpawnWithTimeoutOptions {
  command: string[];
  stdin?: "pipe" | "inherit" | null;
  timeout?: number;
}

export interface SpawnResult {
  stdout: ArrayBuffer;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT = 15000;
const EMPTY_BUFFER = new ArrayBuffer(0);

let spawnCounter = 0;

export async function spawnWithTimeout(options: SpawnWithTimeoutOptions): Promise<SpawnResult> {
  const { command, stdin = null, timeout = DEFAULT_TIMEOUT } = options;

  const tmpFile = join(tmpdir(), `opds-spawn-${process.pid}-${spawnCounter++}.tmp`);

  const proc = Bun.spawn(command, {
    stdin,
    stdout: Bun.file(tmpFile),
    stderr: "ignore",
  });

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may already be dead
      }
    }, 1000);
  }, timeout);

  try {
    const exitCode = await proc.exited;
    if (timedOut) return { stdout: EMPTY_BUFFER, exitCode: -1, timedOut: true };

    const fh = await open(tmpFile, "r");
    try {
      const { size } = await fh.stat();
      if (size === 0) return { stdout: EMPTY_BUFFER, exitCode, timedOut: false };
      const buffer = new Uint8Array(size);
      await fh.read(buffer, 0, size, 0);
      return { stdout: buffer.buffer as ArrayBuffer, exitCode, timedOut: false };
    } finally {
      await fh.close();
    }
  } catch {
    return { stdout: EMPTY_BUFFER, exitCode: timedOut ? -1 : 1, timedOut };
  } finally {
    clearTimeout(timeoutId);
    unlink(tmpFile).catch(() => {});
  }
}

export async function spawnWithTimeoutText(
  options: SpawnWithTimeoutOptions,
): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
  const result = await spawnWithTimeout(options);
  return {
    stdout: new TextDecoder().decode(result.stdout),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}
