import type { FormatHandlerFactory, FormatHandlerRegistration } from "./types.ts";
import { epubHandlerRegistration } from "./epub.ts";
import { comicHandlerRegistration } from "./comic.ts";
import { fb2HandlerRegistration } from "./fb2.ts";
import { mobiHandlerRegistration } from "./mobi.ts";

const registrations: FormatHandlerRegistration[] = [
  epubHandlerRegistration,
  comicHandlerRegistration,
  fb2HandlerRegistration,
  mobiHandlerRegistration,
];

const factoryMap = new Map<string, FormatHandlerFactory>();

for (const reg of registrations) {
  for (const ext of reg.extensions) {
    factoryMap.set(ext.toLowerCase(), reg.create);
  }
}

export function getHandlerFactory(extension: string): FormatHandlerFactory | null {
  return factoryMap.get(extension.toLowerCase()) ?? null;
}

export function hasHandler(extension: string): boolean {
  return factoryMap.has(extension.toLowerCase());
}

export type { FormatHandler, FormatHandlerFactory, BookMetadata } from "./types.ts";
