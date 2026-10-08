import { spyOn } from "bun:test";
import { chmod, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface HangingChild {
  readonly pid: number;
  /** The command's stdout file, owned by the command runner. */
  readonly output: string;
}

/**
 * Redirects the named commands to scripts that report their PID and stdout file, then sleep until killed.
 * Bun resolves commands against the PATH it started with, so a spawn spy maps the names and leaves every
 * other command and option alone. `ready(name)` is the file the latest run of that command reports in;
 * every run also reports in its own `<name>.<pid>.report` file (see `waitForHangingChildren`).
 * `intercept` narrows the redirect to matching invocations; the rest run the real command.
 */
export async function installHangingCommands(
  names: readonly string[],
  root: string,
  intercept: (command: readonly string[]) => boolean = () => true,
): Promise<{ ready: (name: string) => string; restore: () => void }> {
  const ready = (name: string) => join(root, `${name}.json`);

  for (const name of names) {
    const script = join(root, name);
    await Bun.write(
      script,
      `#!/bin/sh\nprintf '{"pid":%s,"output":"%s"}' $$ "$(readlink /proc/$$/fd/1)" > "${ready(name)}.$$.tmp"\ncp "${ready(name)}.$$.tmp" "${join(root, name)}.$$.report"\nmv "${ready(name)}.$$.tmp" "${ready(name)}"\nexec sleep 600\n`,
    );
    await chmod(script, 0o755);
  }

  const originalSpawn = Bun.spawn.bind(Bun);

  // SAFETY: the spy forwards Bun.spawn's own arguments unchanged except for the executable name.
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation((command: any, options?: any) =>
    originalSpawn(names.includes(command[0]) && intercept(command) ? [join(root, command[0]), ...command.slice(1)] : command, options),
  );

  return { ready, restore: () => spawnSpy.mockRestore() };
}

export async function waitForHangingChild(ready: string): Promise<HangingChild> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const file = Bun.file(ready);

    if (await file.exists()) return file.json();

    await Bun.sleep(10);
  }

  throw new Error("hanging command did not start");
}

/** Waits until `count` runs of the hanging command `name` installed under `root` have reported. */
export async function waitForHangingChildren(root: string, name: string, count: number): Promise<HangingChild[]> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const reports = (await readdir(root)).filter((file) => file.startsWith(`${name}.`) && file.endsWith(".report"));

    if (reports.length >= count) return Promise.all(reports.map((report) => Bun.file(join(root, report)).json()));

    await Bun.sleep(10);
  }

  throw new Error(`${count} runs of ${name} did not start`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}
