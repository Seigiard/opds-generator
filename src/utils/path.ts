/**
 * Returns all ancestor paths from the given folder path to root (inclusive).
 * Order: from deepest to root (for bottom-up regeneration).
 *
 * @example
 * getAncestorPaths("Science/Fiction/SciFi") => ["Science/Fiction/SciFi", "Science/Fiction", "Science", ""]
 * getAncestorPaths("") => [""]
 */
export function getAncestorPaths(folderPath: string): string[] {
  if (folderPath === "") return [""];

  const parts = folderPath.split("/");
  const paths: string[] = [];

  for (let i = parts.length; i >= 0; i--) {
    paths.push(parts.slice(0, i).join("/"));
  }

  return paths;
}
