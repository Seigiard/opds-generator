import { Context, Effect, Layer, Queue } from "effect";
import { mkdir, rm, readdir, stat, rename, symlink, unlink } from "node:fs/promises";
import { config } from "../config.ts";
import { logger } from "../utils/errors.ts";
import type { EventType } from "./types.ts";

// Config Service
export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    readonly filesPath: string;
    readonly dataPath: string;
    readonly baseUrl: string;
    readonly port: number;
  }
>() {}

// Logger Service
export class LoggerService extends Context.Tag("LoggerService")<
  LoggerService,
  {
    readonly info: (tag: string, msg: string, meta?: Record<string, unknown>) => Effect.Effect<void>;
    readonly warn: (tag: string, msg: string, meta?: Record<string, unknown>) => Effect.Effect<void>;
    readonly error: (tag: string, msg: string, error?: unknown) => Effect.Effect<void>;
    readonly debug: (tag: string, msg: string, meta?: Record<string, unknown>) => Effect.Effect<void>;
  }
>() {}

// FileSystem Service
export class FileSystemService extends Context.Tag("FileSystemService")<
  FileSystemService,
  {
    readonly mkdir: (path: string, options?: { recursive?: boolean }) => Effect.Effect<void, Error>;
    readonly rm: (path: string, options?: { recursive?: boolean }) => Effect.Effect<void, Error>;
    readonly readdir: (path: string) => Effect.Effect<string[], Error>;
    readonly stat: (path: string) => Effect.Effect<{ isDirectory: () => boolean; size: number }, Error>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly writeFile: (path: string, content: string) => Effect.Effect<void, Error>;
    readonly atomicWrite: (path: string, content: string) => Effect.Effect<void, Error>;
    readonly symlink: (target: string, path: string) => Effect.Effect<void, Error>;
    readonly unlink: (path: string) => Effect.Effect<void, Error>;
  }
>() {}

// Deduplication Service (TTL-based)
export class DeduplicationService extends Context.Tag("DeduplicationService")<
  DeduplicationService,
  {
    readonly shouldProcess: (key: string) => Effect.Effect<boolean>;
  }
>() {}

// Event Queue Service
export class EventQueueService extends Context.Tag("EventQueueService")<
  EventQueueService,
  {
    readonly enqueue: (event: EventType) => Effect.Effect<void>;
    readonly enqueueMany: (events: readonly EventType[]) => Effect.Effect<void>;
    readonly size: () => Effect.Effect<number>;
    readonly take: () => Effect.Effect<EventType>;
  }
>() {}

// Error Log Entry type
export interface ErrorLogEntry {
  timestamp: string;
  event_tag: string;
  path?: string;
  error: string;
  stack?: string;
}

// Error Log Service
export class ErrorLogService extends Context.Tag("ErrorLogService")<
  ErrorLogService,
  {
    readonly log: (entry: ErrorLogEntry) => Effect.Effect<void>;
    readonly clear: () => Effect.Effect<void>;
  }
>() {}

// Handler type for registry
export type EventHandler = (
  event: EventType,
) => Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService | ErrorLogService>;

// Handler Registry Service
export class HandlerRegistry extends Context.Tag("HandlerRegistry")<
  HandlerRegistry,
  {
    readonly get: (tag: string) => EventHandler | undefined;
    readonly register: (tag: string, handler: EventHandler) => void;
  }
>() {}

// Live implementations

const LiveConfigService = Layer.succeed(ConfigService, {
  filesPath: config.filesPath,
  dataPath: config.dataPath,
  baseUrl: config.baseUrl,
  port: config.port,
});

const LiveLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg, meta) => Effect.sync(() => logger.info(tag, msg, meta)),
  warn: (tag, msg, meta) => Effect.sync(() => logger.warn(tag, msg, meta)),
  error: (tag, msg, error) => Effect.sync(() => logger.error(tag, msg, error)),
  debug: (tag, msg, meta) => Effect.sync(() => logger.debug(tag, msg, meta)),
});

const LiveFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: (path, options) =>
    Effect.tryPromise({
      try: () => mkdir(path, options),
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  rm: (path, options) =>
    Effect.tryPromise({
      try: () => rm(path, options),
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  readdir: (path) =>
    Effect.tryPromise({
      try: () => readdir(path),
      catch: (e) => e as Error,
    }),

  stat: (path) =>
    Effect.tryPromise({
      try: () => stat(path),
      catch: (e) => e as Error,
    }).pipe(
      Effect.map((s) => ({
        isDirectory: () => s.isDirectory(),
        size: s.size,
      })),
    ),

  exists: (path) =>
    Effect.tryPromise({
      try: async () => {
        const file = Bun.file(path);
        return file.exists();
      },
      catch: () => false,
    }).pipe(Effect.catchAll(() => Effect.succeed(false))),

  writeFile: (path, content) =>
    Effect.tryPromise({
      try: () => Bun.write(path, content),
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  atomicWrite: (path, content) =>
    Effect.tryPromise({
      try: async () => {
        const tmpPath = `${path}.tmp`;
        await Bun.write(tmpPath, content);
        await rename(tmpPath, path);
      },
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  symlink: (target, path) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await unlink(path);
        } catch {
          // ignore if doesn't exist
        }
        await symlink(target, path);
      },
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  unlink: (path) =>
    Effect.tryPromise({
      try: () => unlink(path),
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),
});

// Deduplication Service - TTL-based (500ms window)
const deduplicationState = {
  seen: new Map<string, number>(),
};

const LiveDeduplicationService = Layer.succeed(DeduplicationService, {
  shouldProcess: (key: string) =>
    Effect.sync(() => {
      const now = Date.now();
      const lastSeen = deduplicationState.seen.get(key);
      if (lastSeen && now - lastSeen < 500) return false;
      deduplicationState.seen.set(key, now);
      // Cleanup old entries periodically
      if (deduplicationState.seen.size > 1000) {
        for (const [k, t] of deduplicationState.seen) {
          if (now - t > 5000) deduplicationState.seen.delete(k);
        }
      }
      return true;
    }),
});

// Event Queue Service - created via Layer.effect
const LiveEventQueueService = Layer.effect(
  EventQueueService,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<EventType>();
    return {
      enqueue: (event: EventType) => Queue.offer(queue, event).pipe(Effect.asVoid),
      enqueueMany: (events: readonly EventType[]) => Effect.forEach(events, (e) => Queue.offer(queue, e), { discard: true }),
      size: () => Queue.size(queue),
      take: () => Queue.take(queue),
    };
  }),
);

// Handler Registry - mutable map for handler registration
const handlerRegistryState = {
  handlers: new Map<string, EventHandler>(),
};

const LiveHandlerRegistry = Layer.succeed(HandlerRegistry, {
  get: (tag: string) => handlerRegistryState.handlers.get(tag),
  register: (tag: string, handler: EventHandler) => {
    handlerRegistryState.handlers.set(tag, handler);
  },
});

// Error Log Service - JSONL file in data directory
const errorLogPath = `${config.dataPath}/errors.jsonl`;

const LiveErrorLogService = Layer.succeed(ErrorLogService, {
  log: (entry: ErrorLogEntry) =>
    Effect.promise(async () => {
      const line = JSON.stringify(entry) + "\n";
      const file = Bun.file(errorLogPath);
      const existing = (await file.exists()) ? await file.text() : "";
      await Bun.write(errorLogPath, existing + line);
    }).pipe(
      Effect.catchAll((e) => {
        logger.error("ErrorLogService", "Failed to write error log", e);
        return Effect.void;
      }),
    ),

  clear: () =>
    Effect.promise(async () => {
      await Bun.write(errorLogPath, "");
    }).pipe(
      Effect.catchAll((e) => {
        logger.error("ErrorLogService", "Failed to clear error log", e);
        return Effect.void;
      }),
    ),
});

// Combined live layer
export const LiveLayer = Layer.mergeAll(
  LiveConfigService,
  LiveLoggerService,
  LiveFileSystemService,
  LiveDeduplicationService,
  LiveEventQueueService,
  LiveHandlerRegistry,
  LiveErrorLogService,
);
