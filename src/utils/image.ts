import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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
  } catch {
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
    proc.stdin.end();
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
