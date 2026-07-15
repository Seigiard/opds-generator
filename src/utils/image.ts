import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../logging/index.ts";
export { COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "../constants.ts";

export async function saveBufferAsImage(buffer: Buffer, destPath: string, maxSize: number): Promise<boolean> {
  try {
    await mkdir(dirname(destPath), { recursive: true });
    await sharp(buffer)
      .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
      .toColorspace("srgb")
      .jpeg({ quality: 90 })
      .toFile(destPath);
    return true;
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

    // Two independent pipelines instead of a shared pipeline + .clone(): cloning
    // retains ~7 KB of native memory per call (A/B-measured via the memory-leak
    // probe, see docs/known-flaky-tests.md) — real MBs across a large sync.
    await Promise.all([
      sharp(buffer)
        .toColorspace("srgb")
        .resize(coverMaxSize, coverMaxSize, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toFile(coverPath),
      sharp(buffer)
        .toColorspace("srgb")
        .resize(thumbMaxSize, thumbMaxSize, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toFile(thumbPath),
    ]);

    return true;
  } catch (error) {
    log.warn("Image", "Failed to save cover and thumbnail", { file: coverPath, error: String(error) });
    return false;
  }
}
