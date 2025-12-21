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

export async function readZipEntryBinary(
  zipPath: string,
  entryPath: string
): Promise<Buffer | null> {
  try {
    const proc = Bun.spawn([UNZIP, "-p", zipPath, entryPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const data = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || data.byteLength === 0) return null;
    return Buffer.from(data);
  } catch {
    return null;
  }
}

export async function listZipEntries(zipPath: string): Promise<string[]> {
  try {
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
