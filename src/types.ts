export interface FileInfo {
  path: string;
  relativePath: string;
  size: number;
  mtime: number;
  extension: string;
}

export interface FolderInfo {
  path: string;
  name: string;
  subfolders: string[];
  files: FileInfo[];
}

export interface BookMeta {
  title: string;
  author?: string;
  description?: string;
  format: string;
  mimeType: string;
  filePath: string;
  fileSize: number;
  hash: string;
  coverSourcePath?: string;
}

export interface Manifest {
  version: 1;
  hash: string;
  lastScan: number;
  files: Record<string, string>;
  folders: string[];
}

export interface ManifestDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface CatalogStructure {
  rootFolders: FolderInfo[];
  allBooks: BookMeta[];
}

export const MIME_TYPES: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/x-mobi8-ebook",
  fb2: "application/x-fictionbook+xml",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook-rar",
  zip: "application/zip",
  djvu: "image/vnd.djvu",
  txt: "text/plain",
};

export const BOOK_EXTENSIONS = Object.keys(MIME_TYPES);
