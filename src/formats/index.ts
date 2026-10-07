import type { Extractor, FormatExtractorRegistration } from "./types.ts";
import { legacyExtractorRegistration } from "./legacy-adapter.ts";
import { epubExtractorRegistration } from "./epub.ts";
import { comicHandlerRegistration } from "./comic.ts";
import { fb2HandlerRegistration } from "./fb2.ts";
import { mobiExtractorRegistration } from "./mobi.ts";
import { pdfExtractorRegistration } from "./pdf.ts";
import { txtExtractorRegistration } from "./txt.ts";
import { djvuExtractorRegistration } from "./djvu.ts";

const registrations: FormatExtractorRegistration[] = [
  epubExtractorRegistration,
  legacyExtractorRegistration(comicHandlerRegistration),
  legacyExtractorRegistration(fb2HandlerRegistration),
  mobiExtractorRegistration,
  pdfExtractorRegistration,
  txtExtractorRegistration,
  djvuExtractorRegistration,
];

const extractorMap = new Map<string, Extractor>();

for (const reg of registrations) {
  for (const ext of reg.extensions) {
    extractorMap.set(ext.toLowerCase(), reg.extract);
  }
}

export function getExtractor(extension: string): Extractor | null {
  return extractorMap.get(extension.toLowerCase()) ?? null;
}
