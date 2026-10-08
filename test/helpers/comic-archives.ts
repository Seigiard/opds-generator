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

/** Page 0 of the sample CBR renamed to start with "-"; same length, so every header keeps its size. */
export const DASHED_PAGE = `-${SAMPLE_IMAGES[0]!.slice(1)}`;

/**
 * Writes `<dir>/dashed.cbr`: the sample CBR (RAR5) with page 0 renamed to `DASHED_PAGE` and its bytes unchanged.
 * No RAR archiver is available, so the name is rewritten in place. RAR5 keeps the file header twice, in its block
 * and in the quick-open cache, each with a CRC32 of the header; the cache record has its own CRC32 as well.
 */
export async function writeDashedCbr(dir: string): Promise<string> {
  const data = Buffer.from(await Bun.file(join(FIXTURES_DIR, "bobby_make_believe_sample.cbr")).arrayBuffer());

  for (let at = data.indexOf(SAMPLE_IMAGES[0]!); at !== -1; at = data.indexOf(SAMPLE_IMAGES[0]!, at)) data.write(DASHED_PAGE, at);

  for (let block = 8; block < data.length;) {
    const { headerEnd, dataEnd, isQuickOpen } = readRar5Block(data, block);
    rewriteCrc(data, block, headerEnd);

    if (isQuickOpen) rewriteQuickOpenCrcs(data, headerEnd, dataEnd);
    block = dataEnd;
  }

  const path = join(dir, "dashed.cbr");
  await Bun.write(path, data);

  return path;
}

function readVint(data: Buffer, at: number) {
  let value = 0;
  let next = at;

  for (let shift = 0; ; shift += 7) {
    const byte = data[next++]!;
    value += (byte & 0x7f) * 2 ** shift;

    if ((byte & 0x80) === 0) return { value, next };
  }
}

function readRar5Block(data: Buffer, block: number) {
  const size = readVint(data, block + 4);
  const type = readVint(data, size.next);
  const flags = readVint(data, type.next);
  const extra = flags.value & 1 ? readVint(data, flags.next) : { value: 0, next: flags.next };
  const dataSize = flags.value & 2 ? readVint(data, extra.next).value : 0;
  const headerEnd = size.next + size.value;

  return {
    headerEnd,
    dataEnd: headerEnd + dataSize,
    isQuickOpen: type.value === 3 && data.subarray(headerEnd - 2, headerEnd).toString() === "QO",
  };
}

/** Sets the CRC32 at `start` to the checksum of the bytes after it up to `end`. */
function rewriteCrc(data: Buffer, start: number, end: number): void {
  data.writeUInt32LE(Bun.hash.crc32(data.subarray(start + 4, end)), start);
}

// Each quick-open record: CRC32, size, then flags, offset, data size and a copy of a header with its own CRC32.
function rewriteQuickOpenCrcs(data: Buffer, start: number, end: number): void {
  for (let record = start; record < end;) {
    const size = readVint(data, record + 4);
    const recordEnd = size.next + size.value;
    const offset = readVint(data, readVint(data, size.next).next);
    const copy = readVint(data, offset.next);
    rewriteCrc(data, copy.next, copy.next + copy.value);
    rewriteCrc(data, record, recordEnd);
    record = recordEnd;
  }
}

export async function comicTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
