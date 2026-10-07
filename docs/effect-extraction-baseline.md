# Effect extraction: memory and stopping baseline

This file records the memory and stopping values for the Effect-native extraction migration (#40). The contract-removal ticket (#47) compares its run with these values. The gate limits stay as they are (`test/helpers/run-leak-probe.ts`).

## Procedure

1. Use the Docker test image built from the current lockfile: `docker compose -p <project> -f docker-compose.test.yml build`.
2. Run the full suite once: `docker compose -p <project> -f docker-compose.test.yml run --rm test`. Each probe prints `slope`, `two-point`, and `objects` per operation.
3. Run the stopping regression: `docker compose -p <project> -f docker-compose.test.yml run --rm test bun test --rerun-each=20 test/integration/processing/pdf-cover-stop.test.ts`. It prints `PDF cover stop: <ms>`.
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
