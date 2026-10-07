import { Data, type Effect } from "effect";

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

export interface ExtractedBook {
  readonly meta: BookMetadata;
  readonly cover: Buffer | null;
}

// `message` carries the cause's text: the logger writes an error's message and stack, never its `cause`.
interface ExtractionFailedProps {
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}

/** The book yields no usable result. The catalogue caller falls back to the filename title and no cover. */
export class ExtractionFailed extends Data.TaggedError("ExtractionFailed")<ExtractionFailedProps> {
  static of(path: string, cause: unknown): ExtractionFailed {
    return new ExtractionFailed({ path, cause, message: cause instanceof Error ? cause.message : String(cause) });
  }
}

/**
 * Reads a book's metadata and cover in one operation. Interruption is fiber interruption, never `ExtractionFailed`;
 * a cover that cannot be read is `cover: null` with the metadata kept.
 */
export type Extractor = (filePath: string) => Effect.Effect<ExtractedBook, ExtractionFailed>;

export interface FormatExtractorRegistration {
  readonly extensions: readonly string[];
  readonly extract: Extractor;
}

/** Legacy Promise contract, kept only until every format implements `Extractor` (#40). */
export interface FormatHandler {
  getMetadata(): BookMetadata;
  getCover(): Promise<Buffer | null>;
}

export type FormatHandlerFactory = (filePath: string, signal?: AbortSignal) => Promise<FormatHandler | null>;

export interface FormatHandlerRegistration {
  extensions: string[];
  create: FormatHandlerFactory;
}
