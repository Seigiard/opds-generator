import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "./errors.ts";
export { COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "../constants.ts";

export async function saveBufferAsImage(buffer: Buffer, destPath: string, maxSize: number): Promise<boolean> {
  try {
    await mkdir(dirname(destPath), { recursive: true });
    const resize = `${maxSize}x${maxSize}>`;
    const proc = Bun.spawn(["magick", "-", "-resize", resize, "-colorspace", "sRGB", "-quality", "90", destPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(buffer);
    const [, , , exitCode] = await Promise.all([
      proc.stdin.end(),
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
      proc.exited,
    ]);
    return exitCode === 0;
  } catch (error) {
    logger.warn("Image", "Failed to save buffer as image", { dest: destPath, error: String(error) });
    return false;
  }
}
