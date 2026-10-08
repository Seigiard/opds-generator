# Shared synchronization engine: live catalogue, freshness, recovery, shutdown and readiness (#50–#56)

The separate repository is `Seigiard/sync-engine`. OPDS locks a local packed
`@seigiard/sync-engine@0.3.1` artifact in `vendor/`. It is not published to npm.
Its exact `effect@4.0.1` peer uses OPDS's runtime; Effect is not bundled.

## Reproduce

```sh
bun install --frozen-lockfile
git submodule update --init
COMPOSE_PROJECT_NAME=opds49-52 bun run rebuild:test
COMPOSE_PROJECT_NAME=opds49-52 docker compose -f docker-compose.test.yml run --rm test bun test test/integration/lifecycle
COMPOSE_PROJECT_NAME=opds49-52 docker compose -f docker-compose.test.yml run --rm --user 65534 test bun test test/integration/lifecycle/engine-recovery.test.ts --test-name-pattern 'OPDS ignores'
COMPOSE_PROJECT_NAME=opds49-52 docker compose -f docker-compose.test.yml down
```

The tests use temporary trees, production filesystem services and all existing
format registrations. They verify metadata, covers, browser and feed output,
unchanged source bytes, download targets, nested cascades and completion while
required downstream publication is held. Recovery tests verify retained artifacts,
independent work, source-read errors, confirmed removal, stale hints, moves,
state-safe cleanup and the existing non-dot source contract. The non-root command
confirms that excluded unreadable subtrees are skipped before traversal.

## Temporary selection seam

`createLifecycle` selects its scanner through dependency injection.
`createDiskScanner` remains the production choice. For the engine slice, select
`createInitialEngineScanner(deps)` from `src/lifecycle/initial-engine-catalogue.ts`.
Disable reconciliation for this selection. Non-initial requests fail; server
adoption is #57. This scanner runs `initialEngineCatalogue`, an Effect composed
with the public `runInitialPass`. The engine owns traversal and required work
execution. OPDS declares book events and root publication, provides handler
services, and retains extraction and rendering. The scan returns no legacy
work because the engine finished the work before returning.

For incremental catalogue work, select `openEngineCatalogue(deps)` inside
`Effect.scoped`. It composes the public `openSynchronization` package API and
completes the same initial publication before returning a `WorkScheduler`.
Keep the scope open while calling `submit([CatalogueEvent...])`,
`awaitCompletion`, and `status`. Closing the scope joins the owned consumer
before releasing its output lease. Book and new-folder events use existing
Effect handlers. BookDeleted and FolderDeleted use engine-owned associated-output
cleanup and explicit parent refreshes. `engine-source-work.ts` supplies source
authority; `engine-policy.ts` declares source selection and state placement.

The engine combines pending work only for OPDS-declared folder-refresh keys.
A repeated pending refresh moves behind intervening work. A refresh requested
while equivalent work is active schedules one pending follow-up. Handler-returned
cascades enter pending work before active clears. `status.state` stays `working`
until required cascades publish; `complete` means work completion, not freshness.
Typed failures retain their previous results while independent work continues.
`awaitCompletion` resolves after required work drains. `complete-with-errors`
retains public `{ work, cause }` records after that drain. A successful retry
clears the matching OPDS source/folder identity. Defects and interruption still
stop the consumer. Initial failures prevent the final minimum publication.

OPDS owns the propagation rule: a book refreshes its folder, and folder summaries
propagate to the parent only when `_entry.xml` changes without its timestamp.
Each folder still writes its own feed. A book's symlink exists before its entry
is published. A new folder publishes its child feed before `_entry.xml`, so a
parent cannot publish a reference to a missing child feed. Publication is gradual.

## Live selection (#54)

`SYNC_ENGINE=shared` selects `createLiveEngineLifecycle` in `server.ts`.
Compose files forward this variable. The legacy composition remains the default.
`src/catalogue-http.ts` owns the shared Bun-local watcher, resync and status routes.
nginx continues to own external Basic Auth and audience routing.

`openLiveEngineCatalogue(deps)` composes the public `openLiveSynchronization`
inside the caller's Effect scope. The engine owns traversal, each pass, pending
pass coalescing, required processing/publication, and the periodic timer.
`requestPass({force})` returns `started`, `queued` or `rejected`. A pending request
combines with later requests and preserves any forced mode. Requests stay pending
through processing and required publication, rather than only through traversal.
`notify(relativePaths)` retains watcher hints and schedules prompt reconsideration.

Each pass reads current source paths. A post-processing traversal detects size,
mtime, kind, addition and removal changes during execution, and requests another
pass before reporting completion. After detectable changes stop, successful work
converges to the current tree. This traversal is not a snapshot. Same-metadata
changes without a watcher hint are detected when `check: "content"` is selected.

OPDS supplies domain work and final publication through the shared engine options.
Resync writes in place. Existing feeds, HTML and entries remain available while
preparation runs. Every pass declares every applicable book to freshness, including
ordinary resync and reconciliation. The engine receives `force` and `changedPaths`
for each pass; freshness selects actual rebuilding. Watcher hints
use engine coalescing instead of the legacy half-second dedup window, so a second
replacement during active work remains actionable. While the initial scoped
session opens, the HTTP adapter retains dirty hints and ORs resync force requests
for admission immediately after initial publication.

`status` separates the active pass, pending follow-up and work status.
`awaitCompletion` includes all admitted passes and required cascades.
`RECONCILE_INTERVAL` retains its production units and validation. Tests can set
`reconcileIntervalMs` at the composition seam to observe the actual owned timer.

```sh
COMPOSE_PROJECT_NAME=opds49-54 bun run rebuild:test
COMPOSE_PROJECT_NAME=opds49-54 docker compose -f docker-compose.test.yml run --rm test bun test test/integration/lifecycle/live-engine-catalogue.test.ts
COMPOSE_PROJECT_NAME=opds49-54 SYNC_ENGINE=shared TEST_PORT=18554 docker compose -f docker-compose.e2e.yml up -d --build --wait
COMPOSE_PROJECT_NAME=opds49-54 TEST_BASE_URL=http://localhost:18554 bun test test/e2e/nginx.test.ts
COMPOSE_PROJECT_NAME=opds49-54 docker compose -f docker-compose.e2e.yml down
```

## Freshness

`initialEngineCatalogue(deps, options)`, `openEngineCatalogue(deps, options)`,
`openLiveEngineCatalogue(deps, options)` and `createLiveEngineLifecycle(deps, options)`
accept `check: "metadata" | "content"` and
`processingVersions: { book?: string, folder?: string }`. Each version defaults
to `"1"`. Change `book` for extractor/book-entry changes; change `folder` for
feed/browser renderer changes. The engine package version is not a processing
version. All compositions use the exported `engineOptions` declaration.

The package records successful work by application-declared result kind and
source-relative paths. An ordinary initial or live check reuses existing results when
source size, mtime and the relevant processing version match. Required output
paths must exist. A changed book invalidates its required folder publication;
the existing summary comparison still stops unchanged ancestor propagation.
Root publication is declared folder work, so warm checks also reuse root files.

`submit(work)` explicitly reprocesses the submitted results. Pass declarations
use `submit(work, { force: false, changedPaths: [] })` for ordinary checks.
`changedPaths` contains source-relative watcher hints; matching work is
reconsidered even when size and mtime match. A hint during active work prevents
its earlier source read from being recorded as current. `force: true` bypasses saved
freshness. These inputs do not install watcher transport or resync scheduling.

Known limit: without a watcher hint, equal size and mtime can hide replaced
content. Select `check: "content"` to additionally hash regular-file contents.
This reads each declared file and costs more than the default metadata check.

Dirty freshness is invalidated before processing. New successful information
is retained after required work completes. Failed or interrupted batches are
replayed by a fresh instance. Book publication keeps its previous entry on a
pre-publication failure. Engine metadata belongs outside projected source paths.
The dev-only `sync-engine-previous` package alias tests a real packed 0.3.0 to
0.3.1 upgrade against real handlers and dated publications.

### Persistent state composition (#52)

Every OPDS composition selects `DATA/.sync-engine`. The engine canonicalizes the
configured `statePath` through `engineStatePath` and supplies it to both lease and
freshness ownership. The existing DATA mount retains that state across container
recreation. `includeSource` preserves OPDS's non-dot source contract before
traversal and metadata checks. Cleanup protects the state directory and lock inode.
Generic consumers keep the SHA256-keyed external default or configure another
persistent area shared by all owners. Source, state and output layouts are
validated before source writes or output preparation.

Keep the immutable packed 0.3.0 upgrade fixture and its shared configuration
`{ ...engineOptions(deps), statePath: undefined }`. That test verifies the generic
external-default upgrade independently of OPDS's configured state selection.
Ordinary freshness tests use the configured OPDS state.

## Startup readiness (#56)

Minimum = the root `feed.xml` and `index.html`. `initialEngineCatalogue` declares it as
`minimum: [root]` in the engine plan; book and folder work follow as remaining required work.
Remaining work gates `completed`, not `available`. A root `index.html` write failure is a
handler failure, so a feed alone never counts as the minimum. The root is declared again at the
end of `work` so the final feed lists every book.

`GET /status` (Bun-local) reports four independent facts beside the engine fields:

| Fact                         | Meaning                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `available`, `availableFrom` | A usable minimum is in DATA. `prior-output`: both root files existed before verification. `minimum-publication`: this run published them. |
| `verifying`                  | The first pass is opening, or a pass is active or pending.                                                                                |
| `completed`                  | Required work drained and nothing is verifying.                                                                                           |
| `errors`                     | `{ source: "work" \| "pass", message }` records. `work` entries are typed failures retained after completion; `pass` is a failed pass.    |

Failure map for the first pass: without a usable minimum the start promise rejects and the server
exits 1 (the entrypoint passes that status to the container). With a usable minimum the start
promise resolves, nginx keeps serving the previous publication, `errors` holds the pass failure,
and `POST /resync` (or the reconcile interval) opens the session again in the same process.
Download links are symlinks to the source, so they cannot be served while the source itself is absent.

`test/e2e/startup-readiness.test.ts` runs the production image (server, nginx, entrypoint) per
scenario. `test/e2e/startup/` holds its Compose overlay: a PATH `unzip` wrapper that holds real
extraction until `gate/hold-unzip` is removed, and a Bun preload that holds one named
`Bun.write` listed in `gate/holds.json`. Both are test-only mounts; the image is unchanged.

```sh
COMPOSE_PROJECT_NAME=opds49-56 STARTUP_PORT=18557 STARTUP_IMAGE=opds49-56-startup bun test test/e2e/startup-readiness.test.ts
```

In-process counterpart: `test/integration/lifecycle/startup-readiness.test.ts`.

**#57 adoption point.** Docker `HEALTHCHECK` and the Compose probes still test only that
`/feed.xml` exists, which is the legacy seed. Real deployment health under the shared composition
must adopt the minimum: the root feed and the root page, as reported by `available` in `/status`.
#56 leaves the probes unchanged because the legacy composition, still the default, never publishes
the root page early.

Verification record (#56). The full Docker suite (`bun run test`, project `opds49-56`) passed with
0 failures on the committed tree: 707 pass, 1075 assertions, 61 files, 338.79 s, exit 0. An earlier
full run ended 706 pass and 1 fail: `cascade-flow` still pinned the old behavior "a failed
`index.html` write is logged and the handler succeeds". Root and folder page failures are now handler
failures by design, so that test was replaced (handler fails, `feed.xml` exists, no `_entry.xml`)
and the handler contract is owned by `folder-meta-sync.test.ts`. The memory and RSS gates ran at
unchanged limits in both runs.

## Output ownership

### Cooperative shutdown (#55)

`createLiveEngineLifecycle.stop()` closes HTTP admission immediately and interrupts
the session's Effect scope. The engine discards pending work and pass requests,
stops traversal and its timer, and joins owned consumer work before releasing the
lease. An in-flight filesystem/native Promise is awaited. Extraction commands
receive SIGTERM, then SIGKILL after their grace period if needed; stop awaits exit
and temporary-resource cleanup. Cancellation stays interruption, not an ordinary
extraction or handler failure.

Book preparation is interruptible. Once publication starts, the real handler
finishes its download symlink and entry as one owned uninterruptible boundary.
Folder handlers retain their declared publication boundaries too. The public
state becomes `stopped` while cleanup may still expose active work; after stop
resolves, active work and pass are null. Interrupted initial startup rejects its
pending start promise without calling `onFatal`. Server shutdown observes that
rejection without logging an initial-scan failure or changing its exit code.

A new instance scans current sources. Successful-only freshness repeats work
stopped after an output write but before success recording, including unfinished
folder cascades. No durable queue is restored. Handlers tolerate repeated writes
and keep actual download targets valid. This is a cooperative guarantee; SIGKILL,
the server's 8 s hard deadline and power loss can interrupt intermediate writes.

`engine-shutdown.test.ts` holds real publication and native-read boundaries through
the public lifecycle. `engine-signal.test.ts` starts the actual shared server,
delivers SIGTERM during initial and resync extraction, observes Linux child PIDs
and command directories, then starts a new process against the same real trees.
Existing format extraction-stop and memory/resource suites remain applicable.

```sh
COMPOSE_PROJECT_NAME=opds49-55 docker compose -f docker-compose.test.yml run --rm test bun test test/integration/lifecycle/engine-shutdown.test.ts test/integration/lifecycle/engine-signal.test.ts
```

### Lease lifetime

Both selections use the package's `acquireOutputTree` lease. The legacy disk
scanner declares its output path. `createLifecycle.start()` acquires that lease
before starting the consumer or scan, and keeps it until `stop()` joins owned
work. The engine acquires and releases its lease in an Effect scope. An open catalogue
session retains that lease even when its work is complete. Existing
handlers keep interruptible preparation and uninterruptible publication.
While legacy acquisition is pending, watcher admission stays closed and resync
requests combine into a follow-up after initial scan admission. A failed
acquisition starts no consumer, scan or publication.

Linux `flock` is supplied by `util-linux` in both Docker images. A child holds
the lock while its stdin remains open. A handshake confirms acquisition before
work starts. Release closes stdin and waits for exit. Bun's death closes the
pipe and releases the lock. Contention waits at most one second, then fails
with `OutputOwnershipFailed`. Canonical output paths share one persistent
`DATA/.sync-engine/lock` inode. Both legacy lifecycle acquisition and scoped
engine compositions explicitly use this state area. The existing DATA Docker
mount therefore shares the lease and persistent engine state across containers.
Keep the inode stable while owners may acquire it. All compositions sharing DATA
must select this same canonical state area, including aliases of DATA.

OPDS excludes every dot-name source component. The engine checks this application
policy before descending into excluded subtrees; submitted hidden-source hints
also do nothing. Bookkeeping uses that excluded namespace. Non-dot source/output
URLs stay unchanged. Generic engine consumers have unrestricted source projections
and can choose an external persistent state area shared with their output owners.

Cleanup requires a fresh source observation. A missing/unreadable root or a failed
file/folder read is an error, never authority for deleting prior results. OPDS
associates each source path with its mirrored output directory. Engine cleanup
rechecks absence, ignores stale hints, confines removal to DATA and protects the
configured state area. A move is old-path removal plus new-path creation.

The engine requires disjoint source/output trees and excludes source symlinks.
Read errors fail the initial pass instead of publishing an empty replacement.
Initial handler failures drain independent work, prevent final publication and
release ownership.

## Interface fit

- OPDS handlers return required cascades. They finish before the final
  application publication Effect.
- TTRPG can classify the full path listing, which includes directories and
  regular-file metadata. Its optional parallel images need a separate scheduling
  and readiness contract in later tickets; they are not required index dependencies.
- OPML can declare final OPML after required RSS work and cascades. Cache
  projection, domain identity and rendering stay in the application.

## Replace the local package

Run the engine's Docker checks, then `bun pm pack` in its checkout. Copy the
tarball into `vendor/` with a content-qualified filename and update the file
dependency. Run `bun install` and rebuild the OPDS test image. A new basename
avoids Bun's same-path file dependency cache. Consume a packed artifact rather
than a checkout import or symlink.
