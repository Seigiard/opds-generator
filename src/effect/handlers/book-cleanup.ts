import { Effect } from "effect";
import { join, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";

export const bookCleanup = (
	parent: string,
	name: string,
): Effect.Effect<void, Error, ConfigService | LoggerService | FileSystemService> =>
	Effect.gen(function* () {
		const config = yield* ConfigService;
		const logger = yield* LoggerService;
		const fs = yield* FileSystemService;

		const filePath = join(parent, name);
		const relativePath = relative(config.filesPath, filePath);
		const bookDataDir = join(config.dataPath, relativePath);

		yield* logger.info("BookCleanup", `Removing: ${relativePath}`);

		yield* fs.rm(bookDataDir, { recursive: true }).pipe(
			Effect.catchAll((error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return logger.debug("BookCleanup", `Already removed: ${relativePath}`);
				}
				return Effect.fail(error);
			}),
		);

		yield* logger.info("BookCleanup", `Done: ${relativePath}`);
	});
