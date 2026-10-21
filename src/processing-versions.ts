/**
 * Bump these when existing source bytes must produce different published output.
 * Book covers extractor and per-book entry/link output; folder covers feed.xml and folder _entry.xml.
 */
export const PROCESSING_VERSIONS = {
  book: "3",
  folder: "4",
} as const;
