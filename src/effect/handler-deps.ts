import { mkdir, rm, readdir, stat, rename, symlink, unlink } from "node:fs/promises";
import { config } from "../config.ts";
import { log } from "../logging/index.ts";
import type { HandlerDeps } from "../context.ts";

export function buildHandlerDeps(): HandlerDeps {
  return {
    config: {
      filesPath: config.filesPath,
      dataPath: config.dataPath,
      port: config.port,
      reconcileInterval: config.reconcileInterval,
    },
    logger: {
      info: (tag, msg, ctx) => log.info(tag, msg, ctx),
      warn: (tag, msg, ctx) => log.warn(tag, msg, ctx),
      error: (tag, msg, err, ctx) => log.error(tag, msg, err, ctx),
      debug: (tag, msg, ctx) => log.debug(tag, msg, ctx),
    },
    fs: {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      rm: (path, options) => rm(path, options),
      readdir: (path) => readdir(path),
      stat: async (path) => {
        const s = await stat(path);
        return { isDirectory: () => s.isDirectory(), size: s.size };
      },
      exists: async (path) => {
        try {
          return await Bun.file(path).exists();
        } catch {
          return false;
        }
      },
      writeFile: async (path, content) => {
        await Bun.write(path, content);
      },
      atomicWrite: async (path, content) => {
        const tmpPath = `${path}.tmp`;
        await Bun.write(tmpPath, content);
        await rename(tmpPath, path);
      },
      symlink: async (target, path) => {
        try {
          await unlink(path);
        } catch {
          // ignore if doesn't exist
        }
        await symlink(target, path);
      },
      unlink: (path) => unlink(path),
    },
  };
}
