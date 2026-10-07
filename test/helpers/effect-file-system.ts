import { Effect } from "effect";
import type { EffectFileSystemService } from "../../src/effect-file-system.ts";

export function createEffectFileSystemTestDouble(overrides: Partial<EffectFileSystemService> = {}): EffectFileSystemService {
  return {
    mkdir: () => Effect.void,
    rm: () => Effect.void,
    readdir: () => Effect.succeed([]),
    stat: () => Effect.succeed({ isDirectory: () => false, size: 0 }),
    exists: () => Effect.succeed(true),
    writeFile: () => Effect.void,
    atomicWrite: () => Effect.void,
    symlink: () => Effect.void,
    unlink: () => Effect.void,
    ...overrides,
  };
}
