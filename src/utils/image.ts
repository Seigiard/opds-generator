import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../logging/index.ts";
export { COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "../constants.ts";

export async function saveBufferAsImage(buffer: Buffer, destPath: string, maxSize: number): Promise<boolean> {
  try {
    await mkdir(dirname(destPath), { recursive: true });
    const resize = `${maxSize}x${maxSize}>`;
    const proc = Bun.spawn(["magick", "-", "-resize", resize, "-colorspace", "sRGB", "-quality", "90", destPath], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin.write(buffer);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch (error) {
    log.warn("Image", "Failed to save buffer as image", { file: destPath, error: String(error) });
    return false;
  }
}

export async function saveCoverAndThumbnail(
  buffer: Buffer,
  coverPath: string,
  coverMaxSize: number,
  thumbPath: string,
  thumbMaxSize: number,
): Promise<boolean> {
  try {
    await Promise.all([mkdir(dirname(coverPath), { recursive: true }), mkdir(dirname(thumbPath), { recursive: true })]);

    const coverResize = `${coverMaxSize}x${coverMaxSize}>`;
    const thumbResize = `${thumbMaxSize}x${thumbMaxSize}>`;

    const proc = Bun.spawn(
      [
        "magick",
        "-",
        "-resize",
        coverResize,
        "-colorspace",
        "sRGB",
        "-quality",
        "90",
        "-write",
        coverPath,
        "-resize",
        thumbResize,
        "-quality",
        "90",
        thumbPath,
      ],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
    );
    proc.stdin.write(buffer);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch (error) {
    log.warn("Image", "Failed to save cover and thumbnail", { file: coverPath, error: String(error) });
    return false;
  }
}
