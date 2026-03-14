import sharp from "sharp";
import { join } from "node:path";

const REFERENCE_COVER = join(import.meta.dir, "../../files/test/cover.jpg");

export async function compareImages(imageA: Buffer, imageB: Buffer, threshold = 0.15): Promise<{ similar: boolean; rmse: number }> {
  const size = 200;
  const [a, b] = await Promise.all([
    sharp(imageA).resize(size, size, { fit: "fill" }).raw().toBuffer(),
    sharp(imageB).resize(size, size, { fit: "fill" }).raw().toBuffer(),
  ]);

  if (a.length !== b.length) return { similar: false, rmse: 1 };

  let sumSq = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i]! - b[i]!) / 255;
    sumSq += diff * diff;
  }
  const rmse = Math.sqrt(sumSq / a.length);

  return { similar: rmse < threshold, rmse };
}

export async function assertCoverMatchesReference(extractedCover: Buffer, threshold = 0.15): Promise<void> {
  const referenceCover = await Bun.file(REFERENCE_COVER).arrayBuffer();
  const { similar, rmse } = await compareImages(extractedCover, Buffer.from(referenceCover), threshold);

  if (!similar) {
    throw new Error(`Cover does not match reference: RMSE=${rmse.toFixed(4)} > threshold=${threshold}`);
  }
}

export { REFERENCE_COVER };
