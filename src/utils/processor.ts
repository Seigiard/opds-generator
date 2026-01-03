export function encodeUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function normalizeFilenameTitle(filename: string): string {
  return filename
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatFolderDescription(folderCount: number, bookCount: number): string | undefined {
  if (folderCount === 0 && bookCount === 0) return undefined;
  if (folderCount === 0) return `📚 ${bookCount}`;
  if (bookCount === 0) return `🗂 ${folderCount}`;
  return `🗂 ${folderCount} · 📚 ${bookCount}`;
}
