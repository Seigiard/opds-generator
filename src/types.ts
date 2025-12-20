/** Информация о файле из файловой системы */
export interface FileInfo {
  /** Абсолютный путь к файлу */
  path: string;
  /** Относительный путь от корня $FILES */
  relativePath: string;
  /** Размер в байтах */
  size: number;
  /** Время последней модификации (ms timestamp) */
  mtime: number;
  /** Расширение файла (epub, pdf, etc.) */
  extension: string;
}

/** Информация о папке */
export interface FolderInfo {
  /** Относительный путь от корня $FILES */
  path: string;
  /** Имя папки */
  name: string;
  /** Вложенные папки */
  subfolders: string[];
  /** Файлы книг в папке */
  files: FileInfo[];
}

export interface BookMeta {
  title: string;
  format: string;
  mimeType: string;
  filePath: string;
  fileSize: number;
  hash: string;
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
  djvu: "image/vnd.djvu",
  txt: "text/plain",
};

/** Расширения файлов, которые считаются книгами */
export const BOOK_EXTENSIONS = Object.keys(MIME_TYPES);
