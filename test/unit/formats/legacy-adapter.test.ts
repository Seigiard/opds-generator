import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { legacyExtractorRegistration } from "../../../src/formats/legacy-adapter.ts";
import type { FormatHandlerFactory } from "../../../src/formats/types.ts";

const extractorFor = (create: FormatHandlerFactory) => legacyExtractorRegistration({ extensions: ["test"], create }).extract;

describe("legacy extractor adapter", () => {
  test("keeps the metadata when the legacy cover read throws", async () => {
    // #given
    const extract = extractorFor(async () => ({
      getMetadata: () => ({ title: "Kept Title", author: "Kept Author" }),
      getCover: async () => {
        throw new Error("cover archive unreadable");
      },
    }));

    // #when
    const book = await Effect.runPromise(extract("/books/kept.test"));

    // #then
    expect(book).toEqual({ meta: { title: "Kept Title", author: "Kept Author" }, cover: null });
  });

  test("returns the metadata and cover of a legacy handler", async () => {
    // #given
    const cover = Buffer.from("cover bytes");
    const extract = extractorFor(async () => ({ getMetadata: () => ({ title: "Whole Book" }), getCover: async () => cover }));

    // #when
    const book = await Effect.runPromise(extract("/books/whole.test"));

    // #then
    expect(book).toEqual({ meta: { title: "Whole Book" }, cover });
  });

  test("a missing legacy handler is ExtractionFailed for the book path", async () => {
    // #given
    const extract = extractorFor(async () => null);

    // #when
    const error = await Effect.runPromise(Effect.flip(extract("/books/missing.test")));

    // #then
    expect({ tag: error._tag, path: error.path }).toEqual({ tag: "ExtractionFailed", path: "/books/missing.test" });
  });

  test("interruption aborts the factory's signal for a running cover read and waits for it", async () => {
    // #given a handler whose cover read runs until the factory's signal aborts, then tidies up
    const coverStarted = Promise.withResolvers<void>();
    let coverSettled = false;

    const extract = extractorFor(async (_filePath, signal) => ({
      getMetadata: () => ({ title: "Interrupted" }),
      getCover: () =>
        new Promise<Buffer | null>((resolve) => {
          coverStarted.resolve();
          signal?.addEventListener(
            "abort",
            () =>
              setTimeout(() => {
                coverSettled = true;
                resolve(null);
              }, 20),
            { once: true },
          );
        }),
    }));

    const controller = new AbortController();
    const task = Effect.runPromiseExit(extract("/books/interrupted.test"), { signal: controller.signal });
    await coverStarted.promise;

    // #when
    controller.abort();
    const outcome = await Promise.race([task, Bun.sleep(2000).then(() => "still running" as const)]);

    // #then
    expect({
      outcome:
        outcome === "still running"
          ? outcome
          : Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause)
            ? "interrupted"
            : "completed",
      coverSettled,
    }).toEqual({ outcome: "interrupted", coverSettled: true });
  });
});
