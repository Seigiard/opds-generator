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
  bookCount: number;
}

export const MIME_TYPES: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/x-mobipocket-ebook",
  azw3: "application/x-mobi8-ebook",
  fb2: "application/x-fictionbook+xml",
  fbz: "application/x-fictionbook+xml",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook-rar",
  cb7: "application/vnd.comicbook+7z",
  cbt: "application/vnd.comicbook+tar",
  zip: "application/zip",
  djvu: "image/vnd.djvu",
  txt: "text/plain",
};

export const BOOK_EXTENSIONS = Object.keys(MIME_TYPES);
