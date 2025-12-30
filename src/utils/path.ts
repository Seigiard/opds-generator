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

/**
 * Extracts the parent folder path from an XML file path.
 * Returns the folder containing the file, not the folder the file represents.
 *
 * @example
 * xmlFileToParentFolder("Science/book.epub/entry.xml") => "Science"
 * xmlFileToParentFolder("Science/_entry.xml") => "" (parent of Science is root)
 * xmlFileToParentFolder("_feed.xml") => null (root feed, no parent to update)
 * xmlFileToParentFolder("Science/_feed.xml") => "Science" (folder itself needs regen)
 */
export function xmlFileToParentFolder(xmlFilePath: string): string | null {
  const filename = xmlFilePath.split("/").pop();
  if (!filename) return null;

  if (filename === "entry.xml") {
    // Book entry: /path/to/book.epub/entry.xml -> parent is /path/to
    const parts = xmlFilePath.split("/");
    if (parts.length < 2) return "";
    return parts.slice(0, -2).join("/");
  }

  if (filename === "_entry.xml" || filename === "_feed.xml") {
    // Folder entry/feed: /path/to/folder/_entry.xml -> parent is /path/to
    const parts = xmlFilePath.split("/");
    if (parts.length < 2) return filename === "_feed.xml" ? "" : null;
    return parts.slice(0, -2).join("/");
  }

  return null;
}

/**
 * Extracts the folder path that needs regeneration from an XML file path.
 *
 * @example
 * xmlFileToFolderPath("Science/book.epub/entry.xml") => "Science"
 * xmlFileToFolderPath("Science/_feed.xml") => "Science"
 * xmlFileToFolderPath("_feed.xml") => ""
 */
export function xmlFileToFolderPath(xmlFilePath: string): string | null {
  const filename = xmlFilePath.split("/").pop();
  if (!filename) return null;

  if (filename === "entry.xml") {
    // Book entry: parent folder needs regen
    const parts = xmlFilePath.split("/");
    if (parts.length < 2) return "";
    return parts.slice(0, -2).join("/");
  }

  if (filename === "_entry.xml" || filename === "_feed.xml") {
    // Folder's own metadata: this folder needs regen
    const parts = xmlFilePath.split("/");
    if (parts.length < 2) return "";
    return parts.slice(0, -1).join("/");
  }

  return null;
}
