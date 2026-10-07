import { Effect } from "effect";
import { open, type FileHandle } from "node:fs/promises";

export type ArchiveType = "zip" | "rar" | "7z" | "tar";

const MAGIC_BYTES: Record<Exclude<ArchiveType, "tar">, number[]> = {
  zip: [0x50, 0x4b, 0x03, 0x04],
  rar: [0x52, 0x61, 0x72, 0x21],
  "7z": [0x37, 0x7a, 0xbc, 0xaf],
};

const USTAR_MAGIC = [0x75, 0x73, 0x74, 0x61, 0x72]; // "ustar"

/**
 * The archive type by magic bytes, or `null` when the file is unreadable or no known archive.
 * The handle is closed on every path; interruption waits for an in-flight read and stays interruption.
 */
export function detectArchiveType(filePath: string): Effect.Effect<ArchiveType | null> {
  return Effect.acquireUseRelease(
    // oxlint-disable-next-line opds/no-direct-effect-promise -- acquisition runs uninterruptibly, so the open settles before release
    Effect.tryPromise({ try: () => open(filePath, "r"), catch: (cause) => cause }),
    (handle) => Effect.tryPromise({ try: () => readArchiveType(handle), catch: (cause) => cause }).pipe(Effect.uninterruptible),
    // oxlint-disable-next-line opds/no-direct-effect-promise -- release runs uninterruptibly, so the close settles before the effect ends
    (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
  ).pipe(Effect.orElseSucceed(() => null));
}

async function readArchiveType(handle: FileHandle): Promise<ArchiveType | null> {
  const header = new Uint8Array(8);
  await handle.read(header, 0, 8, 0);

  // SAFETY: MAGIC_BYTES declares exactly the three non-tar archive keys above.
  for (const [type, magic] of Object.entries(MAGIC_BYTES) as [Exclude<ArchiveType, "tar">, number[]][]) {
    if (magic.every((byte, i) => header[i] === byte)) return type;
  }

  const tarHeader = new Uint8Array(5);
  await handle.read(tarHeader, 0, 5, 257);

  return USTAR_MAGIC.every((byte, i) => tarHeader[i] === byte) ? "tar" : null;
}
