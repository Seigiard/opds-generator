import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogueHttpHandler } from "../../../src/catalogue-http.ts";
import { buildContext } from "../../../src/context.ts";
import { createLiveEngineLifecycle } from "../../../src/lifecycle/live-engine-lifecycle.ts";

const fixture = join(import.meta.dir, "../../../files/test/Test Book - Test Author.fb2");

const present = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "opds-queued-resync-"));
  const sourcePath = join(root, "source");
  const outputPath = join(root, "output");
  await mkdir(sourcePath);
  const ctx = await buildContext();

  return {
    root,
    sourcePath,
    outputPath,
    deps: { ...ctx, config: { ...ctx.config, filesPath: sourcePath, dataPath: outputPath, reconcileInterval: 0 } },
  };
}

test("a resync queued during recoverable warm-start failure retries without a second request", async () => {
  const { root, sourcePath, outputPath, deps } = await tree();
  const book = join(sourcePath, "Book.fb2");
  await copyFile(fixture, book);
  const first = createLiveEngineLifecycle(deps);
  await first.start();
  await first.stop();
  await copyFile(fixture, join(sourcePath, "Second.fb2"));
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let failOnce = true;

  const flakyDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      readdir: async (path: string) => {
        if (path === sourcePath && failOnce) {
          failOnce = false;
          held.resolve();
          await release.promise;
          throw new Error("Source read denied");
        }

        return deps.fs.readdir(path);
      },
    },
  };

  const runtime = createLiveEngineLifecycle(flakyDeps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
  const url = server.url.href.slice(0, -1);

  try {
    const started = runtime.start();
    await held.promise;
    const resync = await fetch(`${url}/resync`, { method: "POST" });
    release.resolve();
    await started;
    const deadline = Date.now() + 5000;
    let status = await (await fetch(`${url}/status`)).json();

    while ((!status.completed || status.errors.length) && Date.now() < deadline) {
      await Bun.sleep(20);
      status = await (await fetch(`${url}/status`)).json();
    }

    expect({
      resync: resync.status,
      available: status.available,
      completed: status.completed,
      errors: status.errors.length,
      second: await present(join(outputPath, "Second.fb2", "entry.xml")),
    }).toEqual({ resync: 202, available: true, completed: true, errors: 0, second: true });
  } finally {
    release.resolve();
    server.stop(true);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a persistently failing warm-start opening consumes one queued resync and then waits", async () => {
  const { root, sourcePath, deps } = await tree();
  await copyFile(fixture, join(sourcePath, "Book.fb2"));
  const first = createLiveEngineLifecycle(deps);
  await first.start();
  await first.stop();
  await copyFile(fixture, join(sourcePath, "Second.fb2"));
  let attempts = 0;

  const failingDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      readdir: async (path: string) => {
        if (path === sourcePath) {
          attempts += 1;
          throw new Error("Source read denied");
        }

        return deps.fs.readdir(path);
      },
    },
  };

  const runtime = createLiveEngineLifecycle(failingDeps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createCatalogueHttpHandler(runtime) });
  const url = server.url.href.slice(0, -1);

  try {
    await runtime.start();
    const afterStart = attempts;

    const resync = await fetch(`${url}/resync`, { method: "POST" });
    await Bun.sleep(150);
    const afterRetry = attempts;
    await Bun.sleep(150);

    const observed = { resync: resync.status, afterStart, afterRetry, final: attempts };

    expect(observed).toEqual({
      resync: 202,
      afterStart: 1,
      afterRetry: 3,
      final: 3,
    });
  } finally {
    server.stop();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

// Keep a small tail after the final test body for Docker/Bun bind-mount parsing on macOS.
