export interface BookMetadata {
  title: string;
  author?: string;
  description?: string;
}

export interface FormatHandler {
  extensions: string[];
  getMetadata(filePath: string): Promise<BookMetadata>;
  getCover(filePath: string): Promise<Buffer | null>;
}
