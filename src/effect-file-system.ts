import { Context, Data, Effect } from "effect";
import { access, mkdir, readdir, rename, rm, stat, symlink, unlink } from "node:fs/promises";

export interface FileStat {
  isDirectory(): boolean;
  readonly size: number;
}

interface FailureProps {
  readonly operation: string;
  readonly path: string;
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

export const liveEffectFileSystem: EffectFileSystemService = {
  mkdir: (path, options) => fsEffect("mkdir", path, async () => mkdir(path, options)),
  rm: (path, options) => fsEffect("rm", path, async () => rm(path, options)),
  readdir: (path) => fsEffect("readdir", path, () => readdir(path)),
  stat: (path) =>
    fsEffect("stat", path, async () => {
      const s = await stat(path);

      return { isDirectory: () => s.isDirectory(), size: s.size };
    }),
  exists: (path) => fsEffect("exists", path, async () => (await access(path), true)),
  writeFile: (path, content) => fsEffect("writeFile", path, async () => Bun.write(path, content).then(() => undefined)),
  atomicWrite: (path, content) =>
    fsEffect("atomicWrite", path, async () => {
      const tmpPath = `${path}.tmp`;
      await Bun.write(tmpPath, content);
      await rename(tmpPath, path);
    }),
  symlink: (target, path) => fsEffect("symlink", path, async () => symlink(target, path)),
  unlink: (path) => fsEffect("unlink", path, async () => unlink(path)),
};

function fsEffect<A>(operation: string, path: string, run: () => Promise<A>): Effect.Effect<A, FileSystemError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => toFileSystemError(operation, path, cause),
  });
}

function toFileSystemError(operation: string, path: string, cause: unknown): FileSystemError {
  const code = errnoCode(cause);
  const props = { operation, path, message: `${operation} ${path} failed: ${code ?? String(cause)}` };

  if (code === "ENOENT") return new FileSystemNotFound(props);

  if (code === "EEXIST") return new FileSystemAlreadyExists(props);

  if (code === "EACCES" || code === "EPERM") return new FileSystemPermissionDenied(props);

  return new FileSystemFailure(props);
}

function errnoCode(cause: unknown): string | undefined {
  // SAFETY: this mapper is the catch boundary for Node fs and Bun.write failures, which expose errno on `code`.
  return (cause as NodeJS.ErrnoException).code;
}
