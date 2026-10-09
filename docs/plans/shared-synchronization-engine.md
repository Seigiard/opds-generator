# Shared synchronization engine

Status: complete. OPDS Generator, TTRPG Map Viewer and OPML Generator use the released shared engine for the agreed synchronization responsibilities.

Decision: [ADR 0004](../adr/0004-shared-synchronization-engine.md).

## Goal and scope

Fix a shared synchronization mechanism once and deliver that fix to OPDS Generator, OPML Generator and TTRPG Map Viewer through dependency updates.

The deliverable is a synchronization engine in a separate repository, published as a versioned npm library. Each application runs it in its own process and Docker image. The engine and its application handlers use Effect 4. Pure parsing and rendering can remain ordinary functions.

The supported runtime is Bun on Linux/Docker. Development on macOS remains possible; filesystem and external-process behavior is verified in the target environment.

## Responsibility boundary

| Engine                                                                | Application                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Scan sources, receive watcher events, run reconciliation              | Define what files and folders mean                                            |
| Schedule work, combine repeated requests, track dependency completion | Define processing work and dependencies between results                       |
| Track completion and failures; own cancellation and resource lifetime | Extract metadata, render documents, create images                             |
| Manage freshness and cleanup of derived data                          | Declare processing versions, required results and safe publication boundaries |

The engine knows work and dependencies, not books, episodes or maps. Applications retain their HTTP serving and domain-specific endpoints. The engine supplies lifecycle and readiness information for those applications to expose.

## Source authority and identity

The source tree is read-only to the application, but can change during scanning and processing. A scan is not a snapshot.

Source identity is its relative path within the source tree. A move is a removal at the old path and a creation at the new path. An application can maintain domain identifiers separately.

When changes stop, successful processing must bring the derived representation into agreement with the observed source state. Work affected by changes during execution must be reconsidered. Read failures can prevent convergence and must remain visible.

Watcher events accelerate detection. Periodic reconciliation repairs changes missed by the watcher. Work completion must include required downstream work; a quiet period or a delayed notification about an output write is not proof of completion.

## Freshness

The default freshness check uses source size, modification time and the application-declared processing version for the relevant kind of result.

- A watcher change event requires the affected source to be reconsidered even when size and modification time match.
- A forced pass processes every applicable source.
- An application can choose content hashing where its cost is justified.
- A processing-version change invalidates the affected results. They are rebuilt in place.
- An engine package update alone does not invalidate all results.

Known limit: without a watcher event, the default ordinary pass can miss a content replacement that preserves both size and modification time. Reconciliation does not promise content-level detection beyond the selected freshness check.

## Resync and repeated requests

An ordinary pass processes detected changes. A forced pass reprocesses every applicable source. Both repair the derived representation in place and keep existing results available during processing.

A request received during a pass guarantees a follow-up pass. Multiple such requests combine into one pending follow-up. If any combined request is forced, the follow-up is forced. This is request coalescing, not a promise to retain a separate pass for every caller.

## Publication and dependencies

Publication is gradual. Readers may see a mixture of older and newer results during an update; publication of a whole-tree snapshot is not required.

A result must not publish a reference to a required result that does not yet exist. The application declares which dependencies are required. For example, a book's download target is required for its download link, while a map can appear before an optional preview is ready.

The application defines dependencies; the engine executes work, combines repeated requests and tracks completion across those dependencies. The concrete handler API and scheduling algorithm remain implementation design work.

## Failures and cleanup

Independent work continues when one source cannot be processed. The last successfully published result for the failed part remains available.

A read failure is not evidence that a source was deleted. This applies to inaccessible files, folders and source roots. Cleanup must rely on confirmed absence, not an incomplete observation.

The engine owns a dedicated area of derived data. Applications associate outputs in that area with their source files or folders. Confirmed source removal permits cleanup of the associated obsolete outputs. User data and outputs of other subsystems belong outside that area.

A pass completed with errors is distinct from a confirmed up-to-date representation. An empty queue proves neither successful processing nor freshness by itself.

OPDS reports four independent facts: available, verifying, completed and retained errors (glossary: **Available**, **Verifying**, **Completed**, **Retained error**). They replace the former single `Settled` state. A pass that failed with usable output stays `failed` in the engine and `available` for readers until a retry succeeds.

## Shutdown and restart

On shutdown, the engine stops accepting new work and stops scanning. It cancels processing that has not entered publication, then waits for owned external processes and resources to finish cleanup.

Publication that has started reaches a safe boundary declared by the handler. For example, a book entry and its download link must not be left in an unsafe intermediate state by cooperative shutdown. This guarantee does not make publication immune to abrupt process termination or power loss.

The work queue is in memory. Published results and freshness information survive restart. A startup scan discovers remaining work instead of restoring a durable queue.

Handlers must tolerate repeated execution. A process can stop after it writes a result but before it records success.

## Startup and availability

Previously published results can be served immediately while the startup check runs. Availability and verification state are separate.

On a first startup, the application declares the minimum results needed for readiness. The engine reports when they have been published. If the initial pass cannot prepare that minimum, startup fails.

Readiness does not imply that every optional result is ready or that the full representation has been verified.

## Package delivery

Publish a versioned npm package. Each application records its resolved dependency version in its lockfile.

Verify the engine before a release. Verify the consuming application's integration before adopting the release. One shared fix reaches all three applications through those explicit updates.

The repository is `Seigiard/sync-engine` and the package is `@seigiard/sync-engine`. A release is a maintainer-run `npm publish` of a verified archive (`scripts/verify-pack.ts` in the engine repository); no automation is selected.

## Migration and completion

Consider scenarios from all three applications when designing the interface. Migrate them in this order:

1. **OPDS:** establish the engine with existing Effect handlers and explicit cascades.
2. **TTRPG:** validate a different processing shape, including full passes, parallel image processing and indexes available before optional images.
3. **OPML:** adopt the validated engine and move handlers to Effect 4. Change resync from cache clearing to repair in place.

Extraction is complete only when all three applications use the engine for the agreed shared responsibilities. Moving utility functions alone does not meet the goal.

### Status

- **OPDS: adopted (#57, temporarily testing a final reviewed archive in review follow-up).** The shared package is the only synchronization path in the standard Docker startup. The legacy lifecycle, scanner, consumer and temporary selection are removed. Before merge, publish the final reviewed archive, repin OPDS to the registry version, and remove the temporary runtime archive.
- **TTRPG Map Viewer: adopted (#60).** Production catalog synchronization uses the released engine package. The regeneration controller and temporary `SYNC_ENGINE` selection are removed.
- **OPML Generator: adopted (#63).** Production podcast synchronization uses the released engine package. The legacy queue, scanner, lifecycle and `OPML_SYNC_ENGINE` selection are removed.
- **Final evidence (#64):** release identity, consumer revisions, scenario matrix and delegation audit are recorded in `docs/agents/shared-sync-evidence.md`.

### Behavioral evidence for migration

Use these agreed scenarios when verifying future engine releases:

- Changes during processing are eventually reflected after the source stops changing.
- A missed watcher event is repaired by reconciliation when the selected freshness check can detect it.
- Several resync requests during a pass produce a follow-up, with a forced request preserved.
- A processing-version change rebuilds affected results without first clearing the published representation.
- A failed read keeps the previous result; a confirmed removal permits cleanup.
- Required dependencies exist before links to them appear; optional previews can finish later.
- Cooperative shutdown waits for resource cleanup and a safe publication boundary.
- Restart discovers unfinished work and safely repeats processing.
- A warm startup serves existing results while verification runs; a first startup fails if its minimum publication cannot be prepared.
- Completion with errors is visible even after all work has stopped.

The #64 evidence maps each scenario to the test or smoke step that currently owns it.

## Relationship to existing decisions

OPDS [ADR 0001](../adr/0001-resync-repairs-in-place.md) already establishes repair-in-place resync. [ADR 0002](../adr/0002-cascades-replace-data-watcher.md) establishes explicit cascades instead of output-watcher propagation. Both inform this contract.

[ADR 0003](../adr/0003-effect-owns-event-processing.md) kept lifecycle execution plain async while handlers moved to Effect. That boundary is now superseded: ADR 0004 governs the shared engine lifecycle, and OPDS runs the released engine for scanning, scheduling, reconciliation, retry and shutdown.

OPML currently has pass-scoped publication completion and a private cache-path layout. TTRPG uses full regeneration and publishes indexes before image work finishes. Their migrations must satisfy this contract while preserving domain-specific output and URL requirements.
