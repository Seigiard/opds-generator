/**
 * Bump these when existing source bytes must produce different published output.
 * Book covers extractor and per-book entry/link output; folder covers feed.xml, index.html and folder _entry.xml.
 */
export const PROCESSING_VERSIONS = {
  book: "2",
  folder: "2",
} as const;
