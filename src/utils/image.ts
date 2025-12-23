import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "./errors.ts";

export const COVER_MAX_SIZE = 1400;
export const THUMBNAIL_MAX_SIZE = 512;

export async function resizeImage(
  srcPath: string,
  destPath: string,
  maxSize: number
): Promise<boolean> {
  try {
    await mkdir(dirname(destPath), { recursive: true });
    const resize = `${maxSize}x${maxSize}>`;
    await Bun.$`magick ${srcPath} -resize ${resize} -colorspace sRGB -quality 90 ${destPath}`.quiet();
    return true;
  } catch (error) {
    logger.warn("Image", "Failed to resize image", { src: srcPath, dest: destPath, error: String(error) });
    return false;
  }
}

export async function saveBufferAsImage(
  buffer: Buffer,
  destPath: string,
  maxSize: number
): Promise<boolean> {
  try {
    await mkdir(dirname(destPath), { recursive: true });
    const resize = `${maxSize}x${maxSize}>`;
    const proc = Bun.spawn(
      ["magick", "-", "-resize", resize, "-colorspace", "sRGB", "-quality", "90", destPath],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
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
