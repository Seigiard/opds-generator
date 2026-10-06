import { Effect, Option } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../logging/index.ts";

interface SpawnWithTimeoutOptions {
  command: string[];
  stdin?: "pipe" | "inherit" | null;
  timeout?: number;
  signal?: AbortSignal;
}

interface SpawnResult {
  stdout: ArrayBuffer;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT = 15000;

const TERMINATION_GRACE = 1000;

const EMPTY_BUFFER = new ArrayBuffer(0);

const textDecoder = new TextDecoder();

const temporaryDirectory = Effect.fnUntraced(function* (prefix: string) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), prefix)), catch: (cause) => cause }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
});

function signalChild(proc: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    proc.kill(signal);
  } catch (error) {
    if (proc.exitCode === null) {
      log.warn("Command", `Failed to send ${signal} to child ${proc.pid}`, { error: String(error) });
    }
  }
}

const releaseChild = Effect.fnUntraced(function* (proc: Bun.Subprocess) {
  if (proc.exitCode !== null) return;
  signalChild(proc, "SIGTERM");
  const exited = yield* Effect.promise(() => proc.exited).pipe(Effect.interruptible, Effect.timeoutOption(TERMINATION_GRACE));

  if (Option.isNone(exited)) {
    signalChild(proc, "SIGKILL");
    yield* Effect.promise(() => proc.exited);
  }
});

const executeCommand = Effect.fnUntraced(function* (options: SpawnWithTimeoutOptions) {
  const directory = yield* temporaryDirectory("opds-spawn-");
  const output = join(directory, "stdout");

  const fd = yield* Effect.acquireRelease(Effect.try({ try: () => openSync(output, "wx"), catch: (cause) => cause }), (value) =>
    Effect.sync(() => closeSync(value)),
  );

  const proc = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Bun.spawn(options.command, { stdin: options.stdin ?? null, stdout: fd, stderr: "ignore" }),
      catch: (cause) => cause,
    }),
    releaseChild,
  );

  const exit = yield* Effect.tryPromise({ try: () => proc.exited, catch: (cause) => cause }).pipe(
    Effect.timeoutOption(options.timeout ?? DEFAULT_TIMEOUT),
  );

  if (Option.isNone(exit)) return { stdout: EMPTY_BUFFER, exitCode: -1, timedOut: true };

  // A filesystem Promise cannot be cancelled; keep its output alive until the read settles.
  const data = yield* Effect.tryPromise({ try: () => readFile(output), catch: (cause) => cause }).pipe(Effect.uninterruptible);

  return { stdout: new Uint8Array(data).buffer, exitCode: exit.value, timedOut: false };
});

async function runOwned<T, E>(effect: Effect.Effect<T, E>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();

  try {
    const result = await Effect.runPromise(effect, { signal });
    signal?.throwIfAborted();

    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}

export function spawnWithTimeout(options: SpawnWithTimeoutOptions): Promise<SpawnResult> {
  return runOwned(Effect.scoped(executeCommand(options)), options.signal);
}

export async function spawnWithTimeoutText(
  options: SpawnWithTimeoutOptions,
): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
  const result = await spawnWithTimeout(options);

  return { stdout: textDecoder.decode(result.stdout), exitCode: result.exitCode, timedOut: result.timedOut };
}

export function withTemporaryDirectory<T>(prefix: string, use: (directory: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return runOwned(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory(prefix);

        // The callback may read temporary files through native work (sharp/unrar).
        // Wait for it even on interruption; cancellable commands observe the caller's signal.
        return yield* Effect.tryPromise({ try: () => use(directory), catch: (cause) => cause }).pipe(Effect.uninterruptible);
      }),
    ),
    signal,
  );
}
