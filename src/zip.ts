// Full path to unzip (BusyBox intercepts short call in Alpine)
const UNZIP = "/usr/bin/unzip";

export async function readZipEntry(
  zipPath: string,
  entryPath: string
): Promise<string | null> {
  try {
    const proc = Bun.spawn([UNZIP, "-p", zipPath, entryPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return null;
    return output;
  } catch {
    return null;
  }
}

export async function extractZipEntry(
  zipPath: string,
  entryPath: string,
  destPath: string
): Promise<boolean> {
  try {
    const proc = Bun.spawn([UNZIP, "-p", zipPath, entryPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const data = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || data.byteLength === 0) return false;

    await Bun.write(destPath, data);
    return true;
  } catch {
    return false;
  }
}

export async function listZipEntries(zipPath: string): Promise<string[]> {
  try {
    // zipinfo -1 works better than unzip -Z1 in Alpine
    const proc = Bun.spawn(["zipinfo", "-1", zipPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return [];

    return output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
