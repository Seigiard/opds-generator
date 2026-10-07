import { Effect } from "effect";
import { logHandlerError } from "../logging/index.ts";
import { ownedPromise } from "../utils/owned-promise.ts";
import {
  ExtractionFailed,
  type ExtractedBook,
  type Extractor,
  type FormatExtractorRegistration,
  type FormatHandler,
  type FormatHandlerFactory,
  type FormatHandlerRegistration,
} from "./types.ts";

/**
 * Temporary bridge for formats that still expose the Promise handler contract (#40). Remove it with the last legacy factory.
 */
export function legacyExtractorRegistration(registration: FormatHandlerRegistration): FormatExtractorRegistration {
  return { extensions: registration.extensions, extract: legacyExtractor(registration.create) };
}

function legacyExtractor(create: FormatHandlerFactory): Extractor {
  return (filePath) =>
    // One owned Promise for the handler's whole life: the handler keeps the factory's signal for getCover(),
    // so interruption must abort that same signal to stop a running cover read.
    ownedPromise(
      (signal) => readLegacyBook(create, filePath, signal),
      (cause) => ExtractionFailed.of(filePath, cause),
    ).pipe(Effect.flatMap((book) => (book ? Effect.succeed(book) : Effect.fail(ExtractionFailed.of(filePath, "no format handler")))));
}

async function readLegacyBook(create: FormatHandlerFactory, filePath: string, signal: AbortSignal): Promise<ExtractedBook | null> {
  const handler = await create(filePath, signal);

  if (!handler) return null;

  const meta = handler.getMetadata();

  return { meta, cover: await readLegacyCover(handler, filePath, signal) };
}

async function readLegacyCover(handler: FormatHandler, filePath: string, signal: AbortSignal): Promise<Buffer | null> {
  try {
    return await handler.getCover();
  } catch (error) {
    signal.throwIfAborted();
    logHandlerError("Cover", filePath, error);

    return null;
  }
}
