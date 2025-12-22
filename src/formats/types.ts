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
  getMetadata(): BookMetadata;
  getCover(): Promise<Buffer | null>;
}

export type FormatHandlerFactory = (filePath: string) => Promise<FormatHandler | null>;

export interface FormatHandlerRegistration {
  extensions: string[];
  create: FormatHandlerFactory;
}
