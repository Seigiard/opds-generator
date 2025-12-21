export interface BookMetadata {
  title: string;
  author?: string;
  description?: string;
  publisher?: string;
  issued?: string;
  language?: string;
  subjects?: string[];
  pageCount?: number;
  series?: string;
  rights?: string;
}

export interface FormatHandler {
  extensions: string[];
  getMetadata(filePath: string): Promise<BookMetadata>;
  getCover(filePath: string): Promise<Buffer | null>;
}
