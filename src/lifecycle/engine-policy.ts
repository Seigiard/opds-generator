import { join } from "node:path";

/** OPDS source names follow the legacy scanner and watcher adapter contract. */
export function includeCatalogueSource(path: string): boolean {
  return !path.split("/").some((name) => name.startsWith(".") && name !== ".." && name !== ".");
}

/** State shares DATA's persistence and ownership mount without using a supported source name. */
export function catalogueStatePath(dataPath: string): string {
  return join(dataPath, ".sync-engine");
}
