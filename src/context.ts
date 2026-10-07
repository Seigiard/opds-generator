import { access, mkdir, rm, readdir, stat, rename, symlink, unlink } from "node:fs/promises";
import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import type { LogContext } from "./logging/types.ts";

function errnoCode(cause: unknown): string | undefined {
  // SAFETY: callers pass errors from Node fs promises, which expose errno on `code`.
  return (cause as NodeJS.ErrnoException).code;
}

interface ConfigService {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly port: number;
  readonly reconcileInterval: number;
}

interface LoggerService {
  info(tag: string, msg: string, ctx?: LogContext): void;
  warn(tag: string, msg: string, ctx?: LogContext): void;
  error(tag: string, msg: string, cause?: unknown, ctx?: LogContext): void;
  debug(tag: string, msg: string, ctx?: LogContext): void;
}

export interface FileSystemService {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; size: number }>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  atomicWrite(path: string, content: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface DeduplicationService {
  shouldProcess(key: string): boolean;
}

export interface AppContext {
  readonly config: ConfigService;
  readonly logger: LoggerService;
  readonly fs: FileSystemService;
  readonly dedup: DeduplicationService;
}

export type HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">;

export async function buildContext(): Promise<AppContext> {
  const configService: ConfigService = {
    filesPath: config.filesPath,
    dataPath: config.dataPath,
    port: config.port,
    reconcileInterval: config.reconcileInterval,
  };

  const logger: LoggerService = {
    info: (tag, msg, ctx) => log.info(tag, msg, ctx),
    warn: (tag, msg, ctx) => log.warn(tag, msg, ctx),
    error: (tag, msg, err, ctx) => log.error(tag, msg, err, ctx),
    debug: (tag, msg, ctx) => log.debug(tag, msg, ctx),
  };

  const fsService: FileSystemService = {
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
        await access(path);

        return true;
      } catch (error) {
        // ENOTDIR: a path component is a regular file, so nothing exists at the path either.
        const code = errnoCode(error);

        if (code === "ENOENT" || code === "ENOTDIR") return false;

        throw error;
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
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
      }

      await symlink(target, path);
    },
    unlink: (path) => unlink(path),
  };

  const seen = new Map<string, number>();

  const dedup: DeduplicationService = {
    shouldProcess(key: string): boolean {
      const now = Date.now();
      const lastSeen = seen.get(key);

      if (lastSeen && now - lastSeen < 500) return false;
      seen.set(key, now);

      if (seen.size > 100) {
        for (const [k, t] of seen) {
          if (now - t > 2000) seen.delete(k);
        }
      }

      return true;
    },
  };

  return {
    config: configService,
    logger,
    fs: fsService,
    dedup,
  };
}
