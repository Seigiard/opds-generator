import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import {
  effectFileSystemFromPromiseService,
  FileSystemNotFound,
  FileSystemPermissionDenied,
  FileSystemAlreadyExists,
} from "../../src/effect-file-system.ts";
import { buildContext, type FileSystemService } from "../../src/context.ts";

const TEST_DIR = join(tmpdir(), `opds-effect-fs-test-${Date.now()}`);

describe("Effect FileSystemService", () => {
  test("answers exists with false for a missing path", async () => {
    // #given
    const missingPath = join(TEST_DIR, "missing.txt");
    await rm(TEST_DIR, { recursive: true, force: true });
    const { fs } = await buildContext();
    const effectFs = effectFileSystemFromPromiseService(fs);

    // #when
    const found = await Effect.runPromise(effectFs.exists(missingPath));

    // #then
    expect(found).toBe(false);
  });

  test("answers exists with false for a path under a regular file", async () => {
    // #given — ENOTDIR: a component of the path is a file, so nothing can exist below it
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    await writeFile(join(TEST_DIR, "index.html"), "<html />");
    const { fs } = await buildContext();
    const effectFs = effectFileSystemFromPromiseService(fs);

    // #when
    const found = await Effect.runPromise(effectFs.exists(join(TEST_DIR, "index.html", "entry.xml")));

    // #then
    expect(found).toBe(false);
  });

  test("fails exists for a path that cannot be resolved, instead of reading it as absent", async () => {
    // #given — ELOOP: a symlink loop cannot be probed
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    await symlink(join(TEST_DIR, "loop-b"), join(TEST_DIR, "loop-a"));
    await symlink(join(TEST_DIR, "loop-a"), join(TEST_DIR, "loop-b"));
    const { fs } = await buildContext();
    const effectFs = effectFileSystemFromPromiseService(fs);

    // #when
    const failure = await Effect.runPromise(Effect.flip(effectFs.exists(join(TEST_DIR, "loop-a"))));

    // #then
    expect({ tag: failure._tag, operation: failure.operation }).toEqual({ tag: "FileSystemFailure", operation: "exists" });
  });

  test("writes through the context-backed adapter atomicWrite", async () => {
    // #given
    const path = join(TEST_DIR, "nested", "entry.xml");
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, "nested"), { recursive: true });
    const { fs } = await buildContext();
    const effectFs = effectFileSystemFromPromiseService(fs);

    // #when
    await Effect.runPromise(effectFs.atomicWrite(path, "<entry />"));

    // #then
    expect(await Bun.file(path).text()).toBe("<entry />");
  });

  test("maps EACCES promise failures to permission denied with the original cause", async () => {
    // #given
    const path = "/data/book.epub/entry.xml";
    const cause = Object.assign(new Error("access denied"), { code: "EACCES" });
    const effectFs = effectFileSystemFromPromiseService(rejectingFs({ exists: async () => Promise.reject(cause) }));

    // #when
    const failure = await Effect.runPromise(Effect.flip(effectFs.exists(path)));

    // #then
    expect(failure).toEqual(
      new FileSystemPermissionDenied({ operation: "exists", path, cause, message: "exists /data/book.epub/entry.xml failed: EACCES" }),
    );
  });

  test("maps ENOENT and EEXIST promise failures to tagged filesystem errors", async () => {
    // #given
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const existing = Object.assign(new Error("exists"), { code: "EEXIST" });

    const fs = effectFileSystemFromPromiseService(
      rejectingFs({
        readdir: async () => Promise.reject(missing),
        symlink: async () => Promise.reject(existing),
      }),
    );

    // #when
    const failures = await Effect.runPromise(
      Effect.all([Effect.flip(fs.readdir("/data")), Effect.flip(fs.symlink("/books/a.epub", "/data/a.epub"))]),
    );

    // #then
    expect(failures).toEqual([
      new FileSystemNotFound({ operation: "readdir", path: "/data", cause: missing, message: "readdir /data failed: ENOENT" }),
      new FileSystemAlreadyExists({
        operation: "symlink",
        path: "/data/a.epub",
        cause: existing,
        message: "symlink /data/a.epub failed: EEXIST",
      }),
    ]);
  });
});

function rejectingFs(overrides: Partial<FileSystemService>): FileSystemService {
  const fail = async () => {
    throw new Error("unexpected filesystem call");
  };

  return {
    mkdir: fail,
    rm: fail,
    readdir: fail,
    stat: fail,
    exists: fail,
    writeFile: fail,
    atomicWrite: fail,
    symlink: fail,
    unlink: fail,
    ...overrides,
  };
}
