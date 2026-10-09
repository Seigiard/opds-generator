import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../../src/context.ts";
import { openEngineCatalogue } from "../../../src/lifecycle/initial-engine-catalogue.ts";
import { ownedPromise } from "../../../src/utils/owned-promise.ts";
import type { EventType } from "../../../src/processing/types.ts";
import type { WorkStatus } from "@seigiard/sync-engine";

export const EPUB = "Test Book - Test Author.epub";

export const FIXTURES = join(import.meta.dir, "../../../files/test");

let root = "";

export let filesPath = "";

export let dataPath = "";

export const feed = (...segments: string[]): Promise<string> => readFile(join(dataPath, ...segments, "feed.xml"), "utf-8");

export const updatedOf = (xml: string): string => /<updated>([^<]+)<\/updated>/.exec(xml)?.[1] ?? "";

export async function resetCascadeFs(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "opds-engine-cascade-"));
  filesPath = join(root, "files");
  dataPath = join(root, "data");
  await mkdir(filesPath, { recursive: true });
}

export async function cleanupCascadeFs(): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function makeSourceFolders(...folders: string[]): Promise<void> {
  for (const folder of folders) await mkdir(join(filesPath, folder), { recursive: true });
}

export async function addBook(folder: string): Promise<void> {
  await Bun.write(join(filesPath, folder, EPUB), await Bun.file(join(FIXTURES, EPUB)).arrayBuffer());
}

export async function withSession<A>(
  use: (session: { submit: (...events: EventType[]) => Promise<void>; status: () => Promise<WorkStatus<EventType>> }) => Promise<A>,
): Promise<A> {
  const ctx = await buildContext();
  const deps = { ...ctx, config: { ...ctx.config, filesPath, dataPath, reconcileInterval: 0 } };

  return Effect.runPromise(
    Effect.scoped(
      openEngineCatalogue(deps).pipe(
        Effect.flatMap((session) =>
          ownedPromise(
            () =>
              use({
                submit: async (...events) => {
                  await Effect.runPromise(session.submit(events));
                  await Effect.runPromise(session.awaitCompletion);
                },
                status: () => Effect.runPromise(session.status),
              }),
            (cause) => new Error(String(cause)),
          ),
        ),
      ),
    ),
  );
}
