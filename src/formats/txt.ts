import { Effect } from "effect";
import { ExtractionFailed, type ExtractedBook, type FormatExtractorRegistration } from "./types.ts";

/** An empty title lets the catalogue fall back to the filename; plain text has no cover. */
const TXT_BOOK: ExtractedBook = { meta: { title: "" }, cover: null };

const extractTxt = Effect.fn("extractTxt")(function* (filePath: string) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(filePath).exists(),
    catch: (cause) => ExtractionFailed.of(filePath, cause),
  }).pipe(Effect.uninterruptible);

  if (!exists) return yield* ExtractionFailed.of(filePath, "file does not exist");

  return TXT_BOOK;
});

export const txtExtractorRegistration: FormatExtractorRegistration = {
  extensions: ["txt"],
  extract: extractTxt,
};
