import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURES_DIR = join(import.meta.dir, "../../files/test");

export const SAMPLE_CBZ = join(FIXTURES_DIR, "bobby_make_believe_sample.cbz");

/** The four page images of the bobby_make_believe_sample fixtures, in sorted order. */
export const SAMPLE_IMAGES = [0, 1, 2, 3].map((page) => `Bobby-Make-Believe_1915__${page}.jpg`);

/** SHA-256 of each sample image, computed with `shasum -a 256` from the unpacked fixture CBZ. */
export const SAMPLE_IMAGE_SHA256 = [
  "65e186dcb4a94227babe19cbf81aff1f4b693029c3d3e688143f2e5aedf62a07",
  "c7e86ef33d41228041b3adca47b1a743fe0ea780eade8366223ba82ad99fb6d1",
  "d16aa339bcfe905fcab81bd0dc6a13c932c6faac67166529250f3c64d8d81b1b",
  "1ddd5183d823ed9b103318d6d9707317060f8a5d9eb7d59e7f41de06dd657bfe",
] as const;

export type BuildableComic = "cbz" | "cb7" | "cbt";

export function sha256(data: Buffer | null): string | null {
  return data === null ? null : new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** A sample page's bytes, read with `unzip` from the fixture CBZ. */
export async function sampleImage(page: number): Promise<Buffer> {
  return Buffer.from(await Bun.$`unzip -p ${SAMPLE_CBZ} ${SAMPLE_IMAGES[page]!}`.quiet().arrayBuffer());
}

/**
 * Packs `files` (archive path → content) into `<dir>/<name>` with an external archiver: `7zz` for CBZ and CB7,
 * `tar` for CBT. A path ending in `/` creates a directory, which the archive stores as an entry.
 */
export async function buildComic(dir: string, name: string, type: BuildableComic, files: Record<string, string | Buffer>): Promise<string> {
  const contents = await mkdtemp(join(dir, "contents-"));

  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/")) await mkdir(join(contents, path), { recursive: true });
    else await Bun.write(join(contents, path), content);
  }

  const archive = join(dir, name);
  // The archivers recurse into directories, so only top-level names are passed.
  const paths = [...new Set(Object.keys(files).map((path) => path.split("/")[0]!))];

  if (type === "cbt") await Bun.$`tar -cf ${archive} ${paths}`.cwd(contents).quiet();
  else await Bun.$`7zz a ${type === "cbz" ? "-tzip" : "-t7z"} ${archive} ${paths}`.cwd(contents).quiet();

  return archive;
}

export async function comicTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
