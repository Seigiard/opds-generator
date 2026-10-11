# Format extraction

Code: `src/formats/`, `src/utils/archive.ts`, `src/utils/process.ts`. Read `external-commands.md` before changing command execution or temporary resources.

## Registration and failure

- A format exports a `FormatExtractorRegistration`. Its `extract(filePath)` returns `Effect<ExtractedBook, ExtractionFailed>` from `src/formats/types.ts`, and the registration belongs in `src/formats/index.ts`.
- Follow `pdf.ts` for commands, `djvu.ts` for concurrent commands and native work on a temporary file, and `epub.ts` or `fb2.ts` for entries through the archive dispatcher.
- Yield `runCommand` and `useTemporaryDirectory` from `src/utils/process.ts`. Recover a cover failure as `cover: null` while keeping metadata. Fail with `ExtractionFailed` only when no usable result exists.
- Interruption is not a failure. Recover with `Effect.catchTag` so interruption passes through unchanged.

## Reads and publication

- A format without commands (`mobi.ts`, `txt.ts`, or plain `fb2.ts`) reads with `Effect.tryPromise(...).pipe(Effect.uninterruptible)`. Stop waits for the read, then takes effect before parsing. Keep parsing synchronous; a parser throw becomes `ExtractionFailed`.
- Cancellation before publication leaves the existing `entry.xml` untouched, although images may already be refreshed. After entry/link publication starts, finish both writes so an entry keeps its download link.
- Validate watcher events, parsed XML values, and reader event details at input boundaries with `valibot`. `src/formats/xml-value.ts` owns the recursive XML value contract.
- Build feed objects with `opds-ts/v1.2` (`Entry`, `Feed`); see `src/utils/opds.ts`.

## Runtime tools

EPUB and FBZ need `unzip`. PDF needs `poppler-utils`. DJVU needs `djvulibre`. Comics need `7zip` (`7zz`) and `tar`. RAR uses bundled `node-unrar-js` WASM. These system tools exist only in the Docker image.
