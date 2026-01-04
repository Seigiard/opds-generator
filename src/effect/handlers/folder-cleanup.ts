import { Effect } from "effect";
import { join, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";

export const folderCleanup = (
	parent: string,
	name: string,
): Effect.Effect<void, Error, ConfigService | LoggerService | FileSystemService> =>
	Effect.gen(function* () {
		const config = yield* ConfigService;
		const logger = yield* LoggerService;
		const fs = yield* FileSystemService;

		const folderPath = join(parent, name);
		const relativePath = relative(config.filesPath, folderPath);
		const folderDataDir = join(config.dataPath, relativePath);

		yield* logger.info("FolderCleanup", `Removing: ${relativePath}`);

		yield* fs.rm(folderDataDir, { recursive: true }).pipe(
			Effect.catchAll((error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return logger.debug("FolderCleanup", `Already removed: ${relativePath}`);
				}
				return Effect.fail(error);
			}),
		);

		yield* logger.info("FolderCleanup", `Done: ${relativePath}`);
	});
