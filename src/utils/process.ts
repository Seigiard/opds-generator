export interface SpawnWithTimeoutOptions {
  command: string[];
  stdin?: "pipe" | "inherit" | null;
  timeout?: number;
}

export interface SpawnResult {
  stdout: ArrayBuffer;
  stderr: ArrayBuffer;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT = 15000;

export async function spawnWithTimeout(options: SpawnWithTimeoutOptions): Promise<SpawnResult> {
  const { command, stdin = null, timeout = DEFAULT_TIMEOUT } = options;

  const proc = Bun.spawn(command, {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may already be dead
        }
      }, 1000);
      reject(new Error(`Process timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).arrayBuffer(), proc.exited]),
      timeoutPromise,
    ]);

    if (timedOut) {
      return { stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: -1, timedOut: true };
    }

    return { stdout, stderr, exitCode, timedOut: false };
  } catch {
    if (timedOut) {
      return { stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: -1, timedOut: true };
    }
    throw new Error(`Process failed: ${command.join(" ")}`);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
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
