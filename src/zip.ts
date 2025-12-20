/**
 * Минимальные утилиты для работы с ZIP через unzip
 */

/**
 * Читает файл из ZIP архива в строку
 */
export async function readZipEntry(
  zipPath: string,
  entryPath: string
): Promise<string | null> {
  try {
    const proc = Bun.spawn(["unzip", "-p", zipPath, entryPath], {
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

/**
 * Извлекает файл из ZIP в указанный путь
 */
export async function extractZipEntry(
  zipPath: string,
  entryPath: string,
  destPath: string
): Promise<boolean> {
  try {
    const proc = Bun.spawn(["unzip", "-p", zipPath, entryPath], {
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

/**
 * Возвращает список файлов в ZIP архиве
 */
export async function listZipEntries(zipPath: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(["unzip", "-Z1", zipPath], {
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
