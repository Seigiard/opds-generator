import { Context, Data, Effect } from "effect";
import type { FileSystemService } from "./context.ts";
import { ownedPromise } from "./utils/owned-promise.ts";

export interface FileStat {
  isDirectory(): boolean;
  readonly size: number;
}

interface FailureProps {
  readonly operation: string;
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}

export class FileSystemNotFound extends Data.TaggedError("FileSystemNotFound")<FailureProps> {}

export class FileSystemAlreadyExists extends Data.TaggedError("FileSystemAlreadyExists")<FailureProps> {}

export class FileSystemPermissionDenied extends Data.TaggedError("FileSystemPermissionDenied")<FailureProps> {}

export class FileSystemFailure extends Data.TaggedError("FileSystemFailure")<FailureProps> {}

export type FileSystemError = FileSystemNotFound | FileSystemAlreadyExists | FileSystemPermissionDenied | FileSystemFailure;

export interface EffectFileSystemService {
  mkdir(path: string, options?: { recursive?: boolean }): Effect.Effect<void, FileSystemError>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Effect.Effect<void, FileSystemError>;
  readdir(path: string): Effect.Effect<string[], FileSystemError>;
  stat(path: string): Effect.Effect<FileStat, FileSystemError>;
  exists(path: string): Effect.Effect<boolean, FileSystemError>;
  writeFile(path: string, content: string): Effect.Effect<void, FileSystemError>;
  atomicWrite(path: string, content: string): Effect.Effect<void, FileSystemError>;
  symlink(target: string, path: string): Effect.Effect<void, FileSystemError>;
  unlink(path: string): Effect.Effect<void, FileSystemError>;
}

export class EffectFileSystem extends Context.Service<EffectFileSystem, EffectFileSystemService>()("EffectFileSystem") {}

export function effectFileSystemFromPromiseService(fs: FileSystemService): EffectFileSystemService {
  return {
    mkdir: (path, options) => fsEffect("mkdir", path, () => fs.mkdir(path, options)),
    rm: (path, options) => fsEffect("rm", path, () => fs.rm(path, options)),
    readdir: (path) => fsEffect("readdir", path, () => fs.readdir(path)),
    stat: (path) => fsEffect("stat", path, () => fs.stat(path)),
    // Only a missing path answers false; any other errno (EACCES, ELOOP, …) is a failure, not "absent".
    exists: (path) =>
      fsEffect("exists", path, () => fs.exists(path)).pipe(Effect.catchTag("FileSystemNotFound", () => Effect.succeed(false))),
    writeFile: (path, content) => fsEffect("writeFile", path, () => fs.writeFile(path, content)),
    atomicWrite: (path, content) => fsEffect("atomicWrite", path, () => fs.atomicWrite(path, content)),
    // Keeps the Promise service's unlink-first replacement behavior.
    symlink: (target, path) => fsEffect("symlink", path, () => fs.symlink(target, path)),
    unlink: (path) => fsEffect("unlink", path, () => fs.unlink(path)),
  };
}

// A filesystem Promise cannot be cancelled: interruption waits for it, so no write outlives its fiber.
function fsEffect<A>(operation: string, path: string, run: () => Promise<A>): Effect.Effect<A, FileSystemError> {
  return ownedPromise(run, (cause) => toFileSystemError(operation, path, cause));
}

function toFileSystemError(operation: string, path: string, cause: unknown): FileSystemError {
  const code = errnoCode(cause);
  const props = { operation, path, cause, message: `${operation} ${path} failed: ${code ?? String(cause)}` };

  if (code === "ENOENT") return new FileSystemNotFound(props);

  if (code === "EEXIST") return new FileSystemAlreadyExists(props);

  if (code === "EACCES" || code === "EPERM") return new FileSystemPermissionDenied(props);

  return new FileSystemFailure(props);
}

function errnoCode(cause: unknown): string | undefined {
  // SAFETY: this mapper is the catch boundary for Node fs and Bun.write failures, which expose errno on `code`.
  return (cause as NodeJS.ErrnoException).code;
}
