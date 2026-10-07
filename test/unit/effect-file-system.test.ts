import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import {
  liveEffectFileSystem,
  EffectFileSystem,
  FileSystemAlreadyExists,
  FileSystemFailure,
  FileSystemPermissionDenied,
} from "../../src/effect-file-system.ts";
import { createEffectFileSystemTestDouble } from "../helpers/effect-file-system.ts";

const TEST_DIR = join(tmpdir(), `opds-effect-fs-test-${Date.now()}`);

describe("Effect FileSystemService", () => {
  test("answers exists with false for a missing path", async () => {
    // #given
    const missingPath = join(TEST_DIR, "missing.txt");
    await rm(TEST_DIR, { recursive: true, force: true });

    // #when
    const found = await Effect.runPromise(liveEffectFileSystem.exists(missingPath));

    // #then
    expect(found).toBe(false);
  });

  test("writes through live atomicWrite", async () => {
    // #given
    const path = join(TEST_DIR, "nested", "entry.xml");
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, "nested"), { recursive: true });

    // #when
    await Effect.runPromise(liveEffectFileSystem.atomicWrite(path, "<entry />"));

    // #then
    expect(await Bun.file(path).text()).toBe("<entry />");
  });

  test("test double returns configured tagged failures", async () => {
    // #given
    const path = "/data/book.epub/entry.xml";

    const fs = createEffectFileSystemTestDouble({
      writeFile: () => Effect.fail(new FileSystemFailure({ operation: "writeFile", path, message: "disk is read-only" })),
    });

    // #when
    const failure = await Effect.runPromise(Effect.flip(fs.writeFile(path, "<entry />")));

    // #then
    expect(failure).toEqual(new FileSystemFailure({ operation: "writeFile", path, message: "disk is read-only" }));
  });

  test("test double can be provided through the Effect service tag", async () => {
    // #given
    const fs = createEffectFileSystemTestDouble({
      readdir: () => Effect.succeed(["book.epub"]),
      symlink: (_target, path) => Effect.fail(new FileSystemAlreadyExists({ operation: "symlink", path, message: "link exists" })),
      unlink: (path) => Effect.fail(new FileSystemPermissionDenied({ operation: "unlink", path, message: "permission denied" })),
    });

    // #when
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* EffectFileSystem;

        return yield* service.readdir("/data");
      }).pipe(Effect.provideService(EffectFileSystem, fs)),
    );

    // #then
    expect(result).toEqual(["book.epub"]);
  });
});
