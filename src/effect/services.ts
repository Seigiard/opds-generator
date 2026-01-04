import { Context, Effect, Layer } from "effect";
import { mkdir, rm, readdir, stat, rename, symlink, unlink } from "node:fs/promises";
import { config } from "../config.ts";
import { logger } from "../utils/errors.ts";

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

// Live implementations

export const LiveConfigService = Layer.succeed(ConfigService, {
	filesPath: config.filesPath,
	dataPath: config.dataPath,
	baseUrl: config.baseUrl,
	port: config.port,
});

export const LiveLoggerService = Layer.succeed(LoggerService, {
	info: (tag, msg, meta) => Effect.sync(() => logger.info(tag, msg, meta)),
	warn: (tag, msg, meta) => Effect.sync(() => logger.warn(tag, msg, meta)),
	error: (tag, msg, error) => Effect.sync(() => logger.error(tag, msg, error)),
	debug: (tag, msg, meta) => Effect.sync(() => logger.debug(tag, msg, meta)),
});

export const LiveFileSystemService = Layer.succeed(FileSystemService, {
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

// Combined live layer
export const LiveLayer = Layer.mergeAll(LiveConfigService, LiveLoggerService, LiveFileSystemService);
