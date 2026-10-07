# Effect extraction: memory and stopping baseline

This file records the memory and stopping values for the Effect-native extraction migration (#40). The contract-removal ticket (#47) compares its run with these values. The gate limits stay as they are (`test/helpers/run-leak-probe.ts`).

## Procedure

1. Use the Docker test image built from the current lockfile: `docker compose -p <project> -f docker-compose.test.yml build`.
2. Run the full suite once: `docker compose -p <project> -f docker-compose.test.yml run --rm test`. Each probe prints `slope`, `two-point`, and `objects` per operation.
3. Run the stopping regressions: `docker compose -p <project> -f docker-compose.test.yml run --rm test bun test --rerun-each=20 test/integration/processing/pdf-cover-stop.test.ts test/integration/processing/djvu-stop.test.ts`. They print `PDF cover stop`, `DJVU cover command stop`, and `DJVU native conversion stop after release` in ms.
4. When a gate is red, run the same probe on the base commit and on the branch in turns, at least three times each, under the same host load. The probes are sensitive to host load: other Docker work on the host moves the RSS slope by several KB.

`handler-chain-effect` is the probe for the extraction path. It processes the PDF, CBZ, and EPUB fixtures in turn through `folderSync`, `bookSync`, and `folderMetaSync`, and requires `entry.xml` and `cover.jpg` for each book.

## Values

Host: macOS Docker Desktop, 2026-10-07, with other worktrees running Docker work (load average 6 to 14). Units: KB of RSS per probe operation, and JS objects per operation.

| Probe                   | Before #41 (7082baa)                    | After #41                               |
| ----------------------- | --------------------------------------- | --------------------------------------- |
| handler-chain-effect    | slope -0.74, two-point 3.11, obj 0.002  | slope -1.78, two-point -1.17, obj 0.002 |
| consumer-enqueue-effect | slope -2.72, two-point -7.34, obj 0.012 | slope -3.12, two-point -4.76, obj 0.012 |
| spawn-echo              | slope 1.37, two-point 1.36, obj 0.072   | slope 1.52, two-point 1.20, obj 0.073   |
| spawn-zipinfo           | slope -0.54, two-point 0.34, obj 0.075  | slope 1.02, two-point 0.79, obj 0.075   |
| full-chain              | slope 3.01, two-point 3.96, obj 0.003   | slope 0.14, two-point 0.17, obj 0.003   |
| lifecycle-scan-effect   | slope 2.23, two-point 2.03, obj 0.018   | slope 10.01, two-point 10.37, obj 0.018 |

Two runs had one red RSS gate each, on paths that #41 does not change:

- Before #41, `full-chain` read 3.01 against its limit of 3.
- After #41, `lifecycle-scan-effect` read 10.01 per 10 cycles against its limit of 1 per cycle. Alternate runs of this probe gave 7.54, 3.13, 5.86 on the base commit and 6.95, 5.99, 4.83 on the branch. The ranges overlap, so the value is host noise.

With the cover requirement added, `handler-chain-effect` read slope -19.12, two-point -8.98, obj 0.002.

## Stopping

- Processor shutdown (`test/unit/processing/processor-shutdown.test.ts`): before, median 26.6 ms and 26.1 ms; after, median 25.9 ms for both scenarios. Leftover 0, started after stop 0.
- PDF cover stop (`test/integration/processing/pdf-cover-stop.test.ts`): from abort to processor stop, 0.6 to 1.7 ms on the legacy Promise path and 0.6 to 1.2 ms on the native path. The cover child exits, the previous `entry.xml` stays, and no download link is created.
- Calibration: when the cover command runs through a Promise bridge without the fiber's interruption, the test fails with `childAlive: true`.

## DJVU (#42)

The CI gate `handler-chain-effect` keeps its calibrated PDF, CBZ, EPUB rotation and its limit of 5. The DJVU values below are diagnostic evidence. Values are slope / two-point KB per book and objects per book; "gate" is the smaller estimator, which the gate compares with the limit.

### First runs: DJVU as a fourth format in the gate

Host: macOS Docker Desktop, 2026-10-07/08, other worktrees running Docker work (load average 6 to 9). These runs went through `docker compose run` on the worktree, with the DJVU source files swapped between conditions in place. Runs alternated between conditions:

| Probe books                 | Runs                                                                                                                                                                | Red |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| PDF, CBZ, EPUB, DJVU native | -31.96 / -22.22, 0.007; 1.43 / 1.37, 0.007; 2.05 / -0.13, 0.015; 3.86 / 6.32, 0.007; 8.99 / 9.41, 0.007; 6.44 / 8.39, 0.007; 4.09 / 1.66, 0.105; 1.89 / 4.03, 0.085 | 2/8 |
| PDF, CBZ, EPUB, DJVU legacy | 5.17 / 7.93, 0.077; -11.88 / -8.78, 0.110; -15.72 / -8.11, 0.005; -6.00 / -18.61, 0.007; 5.09 / 6.23, 0.070                                                         | 2/5 |
| PDF, CBZ, EPUB              | -19.48 / -18.36, 0.003; 0.62 / -2.40, 0.033; -33.79 / -19.81, 0.002                                                                                                 | 0/3 |

The four-format rotation went red on the legacy path as often as on the native path, so these reds do not single out the native mechanism. Three legacy runs (two short, one long) gave no probe result. That harness kept only a filtered or last output line and removed the container, so their exit status and stderr were lost and their cause is not known.

### Matched runs

The second series fixed the harness. Each run is `docker run --rm` of the same test image (Bun 1.4.2, sharp 0.35.5 / libvips 8.18.7, DjVuLibre 3.5.28) with read-only mounts of one exported tree. Baseline is the integration tip `ff065bb` (DJVU through the legacy adapter); native is `9db0220` (#42 merged with that tip). The two trees differ only in `src/formats/djvu.ts` and `src/formats/index.ts`. Both copies of `test/helpers/leak-probe.ts` take the book rotation from an environment variable; that change exists only in the exported copies. Every run records the probe exit status, the container exit status, stderr, and wall time. The probe requires `entry.xml` and `cover.jpg` after each book, so a zero exit means every DJVU book got a cover. Procedure as above: 300 warmup and 600 measured books, a sample every 12; conditions alternated. Host load average 6 to 8, 2026-10-08.

| Books                 | Baseline (legacy)                                                    | Native                                                                 |
| --------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| DJVU only             | -42.37 / -34.91, 0.008; -9.37 / -1.34, 0.010; -15.31 / -11.46, 0.010 | -19.81 / -21.62, 0.010; -17.69 / -10.00, 0.010; -19.01 / -18.28, 0.008 |
| PDF, CBZ, EPUB, DJVU  | -3.70 / -4.47, 0.060; -4.00 / -1.64, 0.058; -10.53 / -8.13, 0.060    | 5.03 / 4.95, 0.075; -4.11 / -3.18, 0.078; -9.23 / -3.29, 0.073         |
| DJVU only, 3000 books | -6.81 / -4.99, 0.0013; RSS thirds 121.2, 114.8, 107.6 MB             | -2.68 / -5.61, 0.0017; RSS thirds 106.9, 100.5, 101.9 MB               |

All 14 runs, 7 on each path, exited 0 with a result. No baseline failure reproduced, so the earlier missing results remain unexplained; they are not evidence of a baseline defect. The handler gate's 180 s `beforeAll` deadline was not a factor: a four-format probe took 76 to 80 s, a DJVU-only probe 184 to 187 s outside the gate, and a 3000-book run 674 to 711 s.

Reading: under matched conditions the native and baseline DJVU paths give overlapping RSS estimates and the same object growth (about 0.01 per DJVU book, 0.06 to 0.08 per book in the four-format rotation). Every gate value is below 5; the closest is native 4.95 in the four-format rotation. In both 3000-book runs RSS ends below its first sample. These runs show no sustained growth on either path at this resolution; per "Known limits" in `docs/memory-oracle-investigation.md`, retention below about 10 KiB per book can still escape this probe.

Stopping (`test/integration/processing/djvu-stop.test.ts`):

- Cover command: from abort to processor stop, 0.4 to 4.0 ms over seven full-suite runs. The `ddjvu` child exits, its page directory is removed, the previous `entry.xml` stays, and no download link or cover is created.
- Native conversion: the processor does not stop while sharp holds the page TIFF; a barrier holds sharp for 300 ms after abort. After release, the stop takes 33 to 70 ms, the real conversion of the TIFF. Native work is not cancelled; the stop waits for it.
- Metadata commands: interruption ends both `djvused` children before the extraction ends, as interruption and not as `ExtractionFailed`.
- Calibration: each scenario fails when its ownership is removed. Without `Effect.uninterruptible` on the sharp call, the processor stops before release and sharp finds no TIFF. With the `djvused` commands behind an abandoned Promise, both children stay alive. With the cover command uninterruptible, the processor is still running after 5 s and the child is alive.

## EPUB and ZIP (#44)

Host: macOS Docker Desktop, 2026-10-07, load average 7 to 8. `list-entries` and `read-entry` now run the shared Effect ZIP operations through the Promise wrappers; `handler-chain-effect` runs the native EPUB extractor. Base and branch runs alternated.

| Probe                | Base (55d6210), slope per run | #44, slope per run           |
| -------------------- | ----------------------------- | ---------------------------- |
| list-entries         | 1.81, 1.75, 1.07, 1.73        | 3.78, 1.70, 6.26, 2.03, 1.93 |
| read-entry           | 1.08, 2.04, 2.69, 1.79        | 3.22, 3.32, 1.25, 2.93, 2.61 |
| handler-chain-effect | -7.78, -30.65                 | -42.75, 0.42, -13.91         |

Objects per operation: `list-entries` and `read-entry` 0.083 to 0.087 before, 0.073 to 0.078 after; `handler-chain-effect` 0.002 on both. All gates passed. The ZIP median is about 0.3 KB per operation higher, with one 6.26 run against the limit of 8.

- EPUB ZIP stop (`test/integration/processing/epub-zip-stop.test.ts`, `--rerun-each=20`): 0.6 to 1.2 ms, one run 4.7 ms. The `unzip` child exits, its output directory is removed, the previous `entry.xml` stays, and no download link is created.
- Calibration: reading the entry through a Promise bridge without the fiber's interruption fails the test with `childAlive: true` and `outputDirectoryExists: true`.

## Comics, RAR, 7z and TAR (#46)

Host: macOS Docker Desktop, 2026-10-08, with other worktrees running Docker work. The new probes `archive-rar`, `archive-7z` and `archive-tar` list the sample comic and read its last page through the Effect dispatch in each operation; their limit is the plain 8 KB per operation. Base and branch runs alternated three rounds; the base copy (206eece) ran the same probe file over its legacy bridge.

| Probe       | Base (206eece), slope per run | #46, slope per run                  |
| ----------- | ----------------------------- | ----------------------------------- |
| archive-rar | -15.01, 4.09, 8.45            | 5.91, 7.29, 3.20, -18.76, 4.26      |
| archive-7z  | -3.03, -12.03, -4.52          | -1.48, -9.54, -1.16, -34.21, -20.83 |
| archive-tar | 2.07, 5.59, 2.46              | 2.65, 5.58, 8.38, 2.86, 4.20        |

Objects per operation: 0.003 to 0.090 on both sides. Each side has one run at or above 8: base `archive-rar` 8.45, #46 `archive-tar` 8.38. The other runs overlap, so neither is evidence of retention; under host load these probes sit close to their limit.

- Comic stops (`test/integration/processing/comic-archive-stop.test.ts`): TAR 1.1 to 2.0 ms and 7z 1.1 to 2.2 ms, with both optional-metadata reads killed and their outputs removed. The RAR stop waits for the held read of the extracted cover (about 100 ms, the test's hold), then removes the temporary directory. The previous `entry.xml` stays and no download link is created.
- Calibration: a shell read through a Promise bridge without the fiber's interruption, and a CoMet read detached from the extraction fiber, fail the shell cases with `childrenAlive: true`. An interruptible read of the extracted RAR file fails the RAR cases.

## Contract removal (#47)

#47 removed the legacy format adapter, the legacy handler types and the Promise wrappers (`spawnWithTimeout`, `spawnWithTimeoutText`, `withTemporaryDirectory`, `runOwned`, archive `listEntries` / `readEntry`). The leak probe now runs the `spawn-*`, `list-entries`, `read-entry` and `full-chain` scenarios through `Effect.runPromise` of the native operations, and each of these operations must return data (an exit code 0, a nonempty listing, a page), so a scenario cannot pass by doing no work.

### Memory

Host: macOS Docker Desktop, 2026-10-08, load average 5 to 7. Image `opds40-47-test` (same lockfile as 7082baa). Each run is `docker run --rm` of `bun test/helpers/leak-probe.ts <scenario>` with read-only mounts of one tree: base is `git archive 7082baa` (before #41, with its own probe file), branch is an rsync mirror of the #47 tree checked with `diff -rq`. Base and branch alternated; all 42 runs exited 0. Values are slope / two-point KB per operation and objects per operation.

| Probe                | Base (7082baa)                                                                                 | #47                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| handler-chain-effect | -3.90 / -6.79, 0.002; 0.14 / 0.56, 0.007; -3.16 / -1.73, 0.002                                 | -6.50 / 0.87, 0.002; -6.07 / -1.57, 0.002; 2.04 / 4.96, 0.002                              |
| full-chain           | -1.17 / -0.55, 0.015; 2.32 / 2.64, 0.003; 2.33 / 2.85, 0.003                                   | 0.59 / 0.96, 0.003; 0.32 / 0.63, 0.003; -6.86 / -32.91, 0.003                              |
| list-entries         | -52.99 / -36.97, 0.085; 3.43 / 4.23, 0.087; 1.83 / 2.19, 0.083                                 | 2.14 / 1.74, 0.082; 2.20 / 1.93, 0.082; 2.00 / 1.98, 0.083                                 |
| read-entry           | -20.65 / -12.86; 2.40 / 2.18; 1.84 / 2.33; 1.77 / 1.99; 0.58 / 1.41; 2.34 / 3.01 (0.085–0.087) | 3.50 / 3.63; 3.88 / 3.85; 3.19 / 2.65; 2.53 / 1.88; 2.18 / 1.63; 2.28 / 2.08 (0.083–0.085) |
| spawn-echo           | 1.47 / 1.95, 0.073; 0.49 / 0.83, 0.073; 0.71 / 1.21, 0.075                                     | 1.59 / 2.49, 0.068; 0.31 / 1.65, 0.070; 0.78 / 1.42, 0.070                                 |
| spawn-zipinfo        | 0.45 / 1.22, 0.073; 1.03 / 1.15, 0.073; 0.55 / 1.63, 0.075                                     | 1.29 / 1.53, 0.070; 1.70 / 2.25, 0.068; 0.93 / 1.95, 0.070                                 |

Reading: every value is below its limit (8; 5 for `handler-chain-effect`, 3 for `full-chain`), and objects per operation are the same or lower on #47. `read-entry` is the one probe whose RSS sits higher: the first three rounds did not overlap, so three more alternated rounds were run; the #47 median is then about 0.9 KB per operation above base, the ranges touch (base 2.34, #47 2.18), and object growth is equal. #44 recorded the same small shift when ZIP reads moved to the Effect dispatch. It is below the probe's resolution for retention (`docs/memory-oracle-investigation.md`, "Known limits") and is recorded here, not explained.

Full suite on the #47 tree (641 pass, 0 fail): `handler-chain-effect` -3.55 / -0.55, `archive-rar` 5.80, `archive-7z` -12.85, `archive-tar` 5.80, `consumer-enqueue-effect` -2.25, `lifecycle-scan-effect` 5.31 per 10 cycles; processor shutdown medians 25.2 and 26.4 ms, leftover 0.

### Stopping

`bun test --rerun-each=20` of the five stop suites, 200 pass, from abort to processor stop: PDF cover 0.4–1.0 ms; DJVU cover command 0.4–0.8 ms, native conversion after release 43.6–56.2 ms; EPUB ZIP 0.6–2.8 ms; FBZ `zipinfo` 0.6–2.7 ms, `unzip` 0.6–1.3 ms; CBT 0.4–6.9 ms; CB7 0.4–1.2 ms; CBR 103.0–115.7 ms (the test's 100 ms hold of the extracted-cover read). These match the slice values above.

### Retired tests and their owners

- `test/unit/formats/legacy-adapter.test.ts` (adapter only): no legacy handler remains. Cover-failure-keeps-metadata is owned per format (`pdf.test.ts`, `djvu.test.ts`, `comic.test.ts`, `epub.test.ts`, `fb2.test.ts` cover-failure cases and the `book-sync.test.ts` publications); stopping during a running cover is owned by `pdf-cover-stop.test.ts` and the other `*-stop.test.ts` suites.
- `process.test.ts` `spawnWithTimeout`: missing executable → `runCommand` "a missing executable fails with CommandFailed and releases acquired descriptors"; cancellation of a SIGTERM-ignoring child → `runCommand` "interruption reaps a child that ignores SIGTERM and releases its output"; timeout → `runCommand` "a timeout kills a child that ignores SIGTERM and releases its output"; stdout, binary output and nonzero exit → the three new `runCommand` result tests.
- `process.test.ts` `withTemporaryDirectory`: uncancellable reader → `useTemporaryDirectory` "interruption keeps the directory until an uninterruptible native read settles"; callback failure → `useTemporaryDirectory` "releases its directory after the work fails".
- `archive.test.ts` "Promise wrappers for legacy callers": dispatch results → the `listArchiveEntries` / `readArchiveEntry` suites; ZIP listing and read abort → `zip.test.ts` "interruption stays interruption, kills the listing/read command and releases its output"; TAR read abort → `archive.test.ts` "interruption of a tar read stays interruption and kills the command".
- `archive.test.ts` "overlapping reads each return their own entry" (uncalibrated: green without the semaphore) → "reads whose extractors are created together each return their own entry". The new test warms the shared WASM instance, then holds each real `createExtractorFromFile` result until a second extractor exists (300 ms fallback). With the RAR semaphore removed it fails (a page reads as `null`: the first extraction wrote into the second read's directory); with it, it passes. Concurrent cold calls each build their own WASM instance, which is why the old test could not collide.
- `queue-consumer.test.ts` "shutdown cancels active command work" kept its scenario and now runs `runCommand` inside an Effect handler instead of a Promise handler with a signal. Calibrated: with `runCommand` made uninterruptible it times out with the child alive.
