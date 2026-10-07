import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot: string | undefined;

async function lint(source: string): Promise<{ exitCode: number; output: string }> {
  fixtureRoot = await mkdtemp(join(tmpdir(), "opds-oxlint-effect-"));
  const configPath = join(fixtureRoot, ".oxlintrc.json");
  const modulePath = join(fixtureRoot, "module.ts");

  await writeFile(
    configPath,
    JSON.stringify({
      jsPlugins: [{ name: "opds", specifier: join(process.cwd(), "tools/oxlint/opds/index.ts") }],
      rules: { "opds/no-direct-effect-promise": "error" },
    }),
  );
  await writeFile(modulePath, ['import { Effect } from "effect";', "", source, ""].join("\n"));

  const proc = Bun.spawn(["bunx", "oxlint", "--config", configPath, "--format", "unix", modulePath], {
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

describe("opds/no-direct-effect-promise", () => {
  test.each([
    ["Effect.promise", "export const a = Effect.promise(() => Promise.resolve(1));"],
    ["Effect.tryPromise", "export const a = Effect.tryPromise({ try: () => Promise.resolve(1), catch: (cause) => cause });"],
    ["an interruptible pipe", "export const a = Effect.promise(() => Promise.resolve(1)).pipe(Effect.interruptible);"],
  ])("reports %s", async (_name, source) => {
    // #given / #when
    const result = await lint(source);

    // #then
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("opds(no-direct-effect-promise)");
  });

  test.each([
    [
      "a crossing piped through Effect.uninterruptible",
      "export const a = Effect.promise(() => Promise.resolve(1)).pipe(Effect.uninterruptible);",
    ],
    [
      "acquire and release of Effect.acquireRelease",
      "export const a = Effect.acquireRelease(Effect.promise(() => Promise.resolve(1)), () => Effect.promise(() => Promise.resolve()));",
    ],
    [
      "a line disabled with its reason",
      "// oxlint-disable-next-line opds/no-direct-effect-promise -- reason\nexport const a = Effect.promise(() => Promise.resolve(1));",
    ],
  ])("allows %s", async (_name, source) => {
    // #given / #when
    const result = await lint(source);

    // #then
    expect({ exitCode: result.exitCode, output: result.output }).toEqual({ exitCode: 0, output: expect.not.stringContaining("opds(") });
  });
});
