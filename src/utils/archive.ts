export type ArchiveType = "zip" | "rar" | "7z";

const MAGIC_BYTES: Record<ArchiveType, number[]> = {
  zip: [0x50, 0x4b, 0x03, 0x04],
  rar: [0x52, 0x61, 0x72, 0x21],
  "7z": [0x37, 0x7a, 0xbc, 0xaf],
};

export async function detectArchiveType(filePath: string): Promise<ArchiveType | null> {
  try {
    const file = Bun.file(filePath);
    const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());

    for (const [type, magic] of Object.entries(MAGIC_BYTES) as [ArchiveType, number[]][]) {
      if (magic.every((byte, i) => header[i] === byte)) {
        return type;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function listEntries(filePath: string): Promise<string[]> {
  const type = await detectArchiveType(filePath);
  if (!type) return [];

  const commands: Record<ArchiveType, string[]> = {
    zip: ["zipinfo", "-1", filePath],
    rar: ["7zz", "l", "-ba", "-slt", filePath],
    "7z": ["7zz", "l", "-ba", "-slt", filePath],
  };

  try {
    const proc = Bun.spawn(commands[type], { stdout: "pipe", stderr: "pipe" });
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return [];

    if (type === "7z" || type === "rar") {
      const paths = output
        .split("\n")
        .filter((line) => line.startsWith("Path = "))
        .map((line) => line.slice(7));
      return paths.slice(1);
    }

    return output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export async function readEntry(filePath: string, entryPath: string): Promise<Buffer | null> {
  const type = await detectArchiveType(filePath);
  if (!type) return null;

  const commands: Record<ArchiveType, string[]> = {
    zip: ["unzip", "-p", filePath, entryPath],
    rar: ["7zz", "e", "-so", filePath, entryPath],
    "7z": ["7zz", "e", "-so", filePath, entryPath],
  };

  try {
    const proc = Bun.spawn(commands[type], { stdout: "pipe", stderr: "pipe" });
    const [data, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    if (exitCode !== 0 || data.byteLength === 0) return null;
    return Buffer.from(data);
  } catch {
    return null;
  }
}

export async function readEntryText(filePath: string, entryPath: string): Promise<string | null> {
  const buffer = await readEntry(filePath, entryPath);
  return buffer ? buffer.toString("utf-8") : null;
}
