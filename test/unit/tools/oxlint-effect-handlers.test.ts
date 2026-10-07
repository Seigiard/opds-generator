import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot: string | undefined;

async function runOxlint(configPath: string, paths: readonly string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["bunx", "oxlint", "--config", configPath, "--format", "unix", ...paths], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  return { exitCode, output: stdout + stderr };
}

afterEach(async () => {
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { force: true, recursive: true });
  fixtureRoot = undefined;
});

describe("anti-slop-effect ownedPromise lint", () => {
  test("rejects direct Effect promise bridges in handler modules while allowing the bridge module", async () => {
    // #given
    fixtureRoot = await mkdtemp(join(tmpdir(), "opds-oxlint-effect-"));
    const handlerDir = join(fixtureRoot, "handlers");
    const bridgeDir = join(fixtureRoot, "bridge");
    await mkdir(handlerDir);
    await mkdir(bridgeDir);

    const handlerPath = join(handlerDir, "bad-handler.ts");
    const bridgePath = join(bridgeDir, "effect-handler.ts");
    const configPath = join(fixtureRoot, ".oxlintrc.json");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          jsPlugins: [
            {
              name: "anti-slop-effect",
              specifier: join(process.cwd(), "tools/oxlint/anti-slop/effect/index.ts"),
            },
          ],
          overrides: [
            {
              files: ["handlers/**/*.ts"],
              rules: {
                "anti-slop-effect/no-direct-effect-promise-in-handlers": "error",
              },
            },
          ],
        },
        undefined,
        2,
      ),
    );
    await writeFile(
      handlerPath,
      [
        'import { Effect } from "effect";',
        "",
        "export const handler = Effect.promise(() => Promise.resolve([]));",
        "export const other = Effect.tryPromise({ try: () => Promise.resolve([]), catch: (cause) => cause });",
        "",
      ].join("\n"),
    );
    await writeFile(
      bridgePath,
      ['import { Effect } from "effect";', "", "export const bridge = Effect.promise(() => Promise.resolve([]));", ""].join("\n"),
    );

    // #when
    const result = await runOxlint(configPath, [handlerPath, bridgePath]);

    // #then
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("anti-slop-effect(no-direct-effect-promise-in-handlers)");
    expect(result.output).not.toContain("effect-handler.ts");
  });
});
