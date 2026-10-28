import type { FeedModel } from "../../src/render/feed-model.ts";
import type { ShellState } from "../../src/render/shell-state.ts";

const LOADING_DELAY_MS = 300;

const PREFETCH_LIMIT = 20;

export interface FolderLoadDeps {
  fetch: (url: string) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  parse: (xml: string) => FeedModel;
}

type LoadResult = Exclude<ShellState, { kind: "skeleton" }>;

/** Load one normalized browser folder path and yield each shell state in order. */
export async function* loadFolder(folderPath: string, deps: FolderLoadDeps): AsyncIterable<ShellState> {
  const request = (): Promise<LoadResult> => loadAttempt(`/_catalog${folderPath}feed.xml`, deps);
  const firstAttempt = request();

  const firstOutcome = await Promise.race([
    firstAttempt.then((result) => ({ kind: "result" as const, result })),
    Promise.resolve()
      .then(() => deps.sleep(LOADING_DELAY_MS))
      .then(() => ({ kind: "delay" as const })),
  ]);

  let result: LoadResult;

  if (firstOutcome.kind === "delay") {
    yield { kind: "skeleton" };
    result = await firstAttempt;
  } else {
    result = firstOutcome.result;
  }

  while (true) {
    if (result.kind !== "starting") {
      yield result;

      return;
    }

    yield result;

    await deps.sleep(result.retryInSeconds * 1000);

    result = await request();
  }
}

/** Select at most 20 eligible child-folder feeds for speculative loading. */
export function folderFeedsToPrefetch(model: FeedModel, saveData: boolean): string[] {
  if (saveData) return [];

  return model.entries.reduce<string[]>((urls, entry) => {
    if (
      urls.length >= PREFETCH_LIMIT ||
      entry.kind !== "folder" ||
      !entry.href ||
      !entry.href.startsWith("/_catalog/") ||
      !entry.href.endsWith("/feed.xml")
    ) {
      return urls;
    }

    urls.push(entry.href);

    return urls;
  }, []);
}

async function loadAttempt(url: string, deps: FolderLoadDeps): Promise<LoadResult> {
  try {
    const response = await deps.fetch(url);

    if (response.status === 503) {
      return { kind: "starting", retryInSeconds: retryAfterSeconds(response) };
    }

    if (response.status === 404) return { kind: "not-found" };

    if (!response.ok) return { kind: "http-error", status: response.status };

    return { kind: "ready", model: deps.parse(await response.text()) };
  } catch (error) {
    return errorState(error instanceof Error ? error.message : undefined);
  }
}

function retryAfterSeconds(response: Response): number {
  const value = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);

  if (!Number.isFinite(value) || value < 0) return 5;

  return Math.min(value, 30);
}

export function errorState(message: string | undefined): { kind: "error"; message?: string } {
  return message === undefined ? { kind: "error" } : { kind: "error", message };
}
