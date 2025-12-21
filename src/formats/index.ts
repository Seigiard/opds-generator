import type { FormatHandler } from "./types.ts";
import { epubHandler } from "./epub.ts";
import { cbzHandler } from "./cbz.ts";

const handlers: FormatHandler[] = [epubHandler, cbzHandler];

const handlerMap = new Map<string, FormatHandler>();

for (const handler of handlers) {
  for (const ext of handler.extensions) {
    handlerMap.set(ext.toLowerCase(), handler);
  }
}

export function getHandler(extension: string): FormatHandler | null {
  return handlerMap.get(extension.toLowerCase()) ?? null;
}

export function hasHandler(extension: string): boolean {
  return handlerMap.has(extension.toLowerCase());
}

export type { FormatHandler, BookMetadata } from "./types.ts";
