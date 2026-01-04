import { Effect } from "effect";
import { dirname, relative } from "node:path";
import { folderMetaSync } from "./folder-meta-sync.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";

export const parentMetaSync = (
	folderDataDir: string,
): Effect.Effect<void, Error, ConfigService | LoggerService | FileSystemService> =>
	Effect.gen(function* () {
		const config = yield* ConfigService;
		const logger = yield* LoggerService;

		const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
		const parentDataDir = dirname(normalizedDir);
		const parentRelativePath = relative(config.dataPath, parentDataDir);

		if (parentDataDir === config.dataPath || parentRelativePath === ".") {
			yield* logger.info("ParentMetaSync", "Parent is root, running folder-meta-sync for root");
			yield* folderMetaSync(config.dataPath);
		} else {
			yield* logger.info("ParentMetaSync", `Running folder-meta-sync for: ${parentRelativePath}`);
			yield* folderMetaSync(parentDataDir);
		}
	});
