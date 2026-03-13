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

export async function spawnWithTimeout(options: SpawnWithTimeoutOptions): Promise<SpawnResult> {
  const { command, stdin = null, timeout = DEFAULT_TIMEOUT } = options;

  const proc = Bun.spawn(command, {
    stdin,
    stdout: "pipe",
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
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    if (timedOut) return { stdout: EMPTY_BUFFER, exitCode: -1, timedOut: true };
    return { stdout, exitCode, timedOut: false };
  } catch {
    return { stdout: EMPTY_BUFFER, exitCode: timedOut ? -1 : 1, timedOut };
  } finally {
    clearTimeout(timeoutId);
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
