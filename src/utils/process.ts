import { Data, Effect, Option } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../logging/index.ts";

interface CommandOptions {
  command: string[];
  stdin?: "pipe" | "inherit" | null;
  timeout?: number;
}

interface SpawnWithTimeoutOptions extends CommandOptions {
  signal?: AbortSignal;
}

interface SpawnResult {
  stdout: ArrayBuffer;
  exitCode: number;
  timedOut: boolean;
}

// `message` carries the cause's text: the logger writes an error's message and stack, never its `cause`.
interface FailureProps {
  readonly cause: unknown;
  readonly message: string;
}

/** The command could not run: no temporary output, no child, or no readable output. A timeout or nonzero exit is a result. */
export class CommandFailed extends Data.TaggedError("CommandFailed")<FailureProps & { readonly command: string }> {}

export class TemporaryDirectoryFailed extends Data.TaggedError("TemporaryDirectoryFailed")<FailureProps & { readonly prefix: string }> {}

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
  // oxlint-disable-next-line opds/no-direct-effect-promise -- the grace timeout must cut this wait; SIGKILL and an uninterruptible wait follow
  const exited = yield* Effect.promise(() => proc.exited).pipe(Effect.interruptible, Effect.timeoutOption(TERMINATION_GRACE));

  if (Option.isNone(exited)) {
    signalChild(proc, "SIGKILL");
    yield* Effect.promise(() => proc.exited).pipe(Effect.uninterruptible);
  }
});

const executeCommand = Effect.fnUntraced(function* (options: CommandOptions) {
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

  // oxlint-disable-next-line opds/no-direct-effect-promise -- on interruption the acquireRelease finalizer kills the child and waits for its exit
  const exit = yield* Effect.tryPromise({ try: () => proc.exited, catch: (cause) => cause }).pipe(
    Effect.timeoutOption(options.timeout ?? DEFAULT_TIMEOUT),
  );

  if (Option.isNone(exit)) return { stdout: EMPTY_BUFFER, exitCode: -1, timedOut: true };

  // A filesystem Promise cannot be cancelled; keep its output alive until the read settles.
  const data = yield* Effect.tryPromise({ try: () => readFile(output), catch: (cause) => cause }).pipe(Effect.uninterruptible);

  return { stdout: new Uint8Array(data).buffer, exitCode: exit.value, timedOut: false };
});

/**
 * Runs one command in its own scope: its child, descriptor, output file and temporary directory are released
 * when this Effect ends, whether by result, failure or interruption. Interruption sends SIGTERM, waits the grace
 * period, then SIGKILL, and waits for the exit.
 */
export function runCommand(options: CommandOptions): Effect.Effect<SpawnResult, CommandFailed> {
  return Effect.scoped(executeCommand(options)).pipe(
    Effect.mapError((cause) => new CommandFailed({ command: options.command[0] ?? "", ...failure(cause) })),
  );
}

export function runCommandText(
  options: CommandOptions,
): Effect.Effect<{ stdout: string; exitCode: number; timedOut: boolean }, CommandFailed> {
  return runCommand(options).pipe(
    Effect.map((result) => ({ stdout: textDecoder.decode(result.stdout), exitCode: result.exitCode, timedOut: result.timedOut })),
  );
}

/**
 * Gives `use` a temporary directory and removes it when `use` ends. `use` stays interruptible, so commands it runs
 * are stopped on interruption. A native Promise reading the directory must cross uninterruptibly, so removal waits for it.
 */
export function useTemporaryDirectory<A, E, R>(
  prefix: string,
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | TemporaryDirectoryFailed, R> {
  return Effect.scoped(
    temporaryDirectory(prefix).pipe(
      Effect.mapError((cause) => new TemporaryDirectoryFailed({ prefix, ...failure(cause) })),
      Effect.flatMap(use),
    ),
  );
}

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

function failure(cause: unknown): FailureProps {
  return { cause, message: cause instanceof Error ? cause.message : String(cause) };
}
