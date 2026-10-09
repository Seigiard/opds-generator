# Shared synchronization engine: production adoption, live catalogue, freshness, recovery, shutdown and readiness (#50–#64)

The separate repository is `Seigiard/sync-engine`. OPDS depends on the released npm package
`@seigiard/sync-engine` (exact version in `package.json`; the lock records the registry tarball and its integrity).
Its exact `effect@4.0.1` peer uses OPDS's runtime; Effect is not bundled. The engine is the only synchronization
path in production: `server.ts` starts `createLiveEngineLifecycle` and nothing else. TTRPG Map Viewer and
OPML Generator have also adopted the released engine. Final cross-application evidence lives in
`docs/agents/shared-sync-evidence.md`.

## Reproduce

```sh
bun install --frozen-lockfile
git submodule update --init
COMPOSE_PROJECT_NAME=opds49-57 bun run rebuild:test
COMPOSE_PROJECT_NAME=opds49-57 docker compose -f docker-compose.test.yml run --rm test bun test test/integration/lifecycle
COMPOSE_PROJECT_NAME=opds49-57 docker compose -f docker-compose.test.yml run --rm --user 65534 test bun test test/integration/lifecycle/engine-recovery.test.ts --test-name-pattern 'OPDS ignores'
COMPOSE_PROJECT_NAME=opds49-57 docker compose -f docker-compose.test.yml down
```

The tests use temporary trees, production filesystem services and all existing
format registrations. They verify metadata, covers, browser and feed output,
unchanged source bytes, download targets, nested cascades and completion while
required downstream publication is held. Recovery tests verify retained artifacts,
independent work, source-read errors, confirmed removal, stale hints, moves,
state-safe cleanup and the existing non-dot source contract. The non-root command
confirms that excluded unreadable subtrees are skipped before traversal.

## Test compositions (#51–#53)

`initialEngineCatalogue(deps)` (`src/lifecycle/initial-engine-catalogue.ts`) runs one initial pass with the public
`runInitialPass`, and `openEngineCatalogue(deps)` opens the scoped session for submitted catalogue work. Production
does not call them. Contract tests use them to drive handlers, freshness, recovery and shutdown at the engine boundary
without a watcher or an HTTP server. `engineOptions` is shared with production, so these tests exercise the real
declaration.

Inside `Effect.scoped`, keep the scope open while calling `submit([CatalogueEvent...])`, `awaitCompletion`, and
`status`. Closing the scope joins the owned consumer before releasing its output lease. Book and new-folder events use
the existing Effect handlers. Confirmed absence uses engine-owned associated-output cleanup and explicit parent
refreshes. Confirmed source-kind changes use OPDS's confined `removeOutputPath` in `engine-source-work.ts` before the
current representation publishes. `engine-source-work.ts` supplies source authority; `engine-policy.ts` declares source
selection and state placement.

The engine combines pending work only for OPDS-declared folder-refresh keys. A repeated pending refresh moves behind
intervening work. A refresh requested while equivalent work is active schedules one pending follow-up.
Handler-returned cascades enter pending work before active clears. `status.state` stays `working` until required
cascades publish; `complete` means work completion, not freshness. Typed failures retain their previous results while
independent work continues. `awaitCompletion` resolves after required work drains. `complete-with-errors` retains
public `{ work, cause }` records after that drain. A successful retry clears the matching OPDS source/folder identity.
Defects and interruption still stop the consumer. A minimum-publication failure prevents availability and remaining work.
A later initial-work failure keeps an already published minimum available but prevents the pass from completing
successfully.

OPDS owns the propagation rule: a book refreshes its folder, and folder summaries propagate to the parent only when
`_entry.xml` changes without its timestamp. Each folder still writes its own feed. A book's symlink exists before its
entry is published. A new folder publishes its child feed before `_entry.xml`, so a parent cannot publish a reference
to a missing child feed. Publication is gradual.

## Live composition (#54, production since #57)

`startLiveEngineCatalogue(deps)` composes the public `startLiveSynchronization` inside the caller's Effect scope.
`createLiveEngineLifecycle` (`src/lifecycle/live-engine-lifecycle.ts`) is the Promise-facing adapter that `server.ts`
runs. `src/catalogue-http.ts` owns the Bun-local watcher, resync and status routes. nginx continues to own external
Basic Auth and audience routing.

The engine owns traversal, each pass, pending pass coalescing, required processing/publication, the periodic timer,
admission while the first pass runs, and the retry of a failed first pass. The adapter keeps no timer, queue or retained
hints. `requestPass({force})` returns `started`, `queued` or `rejected`. A pending request combines with later
requests and preserves any forced mode. Requests stay pending through processing and required publication, rather than
only through traversal. `notify(relativePaths)` retains watcher hints and schedules prompt reconsideration.

Each pass reads current source paths. A post-processing traversal detects size,
mtime, kind, addition and removal changes during execution, and requests another
pass before reporting completion. After detectable changes stop, successful work
converges to the current tree. This traversal is not a snapshot. Same-metadata
changes without a watcher hint are detected when `check: "content"` is selected.

OPDS supplies domain work and final publication through the shared engine options.
Resync writes in place. Existing feeds, HTML and entries remain available while
preparation runs. Every pass declares every applicable book to freshness, including
ordinary resync and reconciliation. The engine receives `force` and `changedPaths`
for each pass; freshness selects actual rebuilding. Watcher hints use engine
coalescing, so a second replacement during active work remains actionable (the former
half-second dedup window is gone). Hints and forced requests made while the first pass
runs are retained by the engine and run as one follow-up after it.

Every pass also declares orphan cleanup (`orphans.ts`). It walks DATA for book entries (`entry.xml`) and folder
entries (`_entry.xml`) whose source is not in the scan, and emits `BookDeleted` / `FolderDeleted` candidates. This
covers sources removed while the service was down, deletions the watcher missed, and the deletion hints the
adapter forwards. The source work removes only on confirmed absence or a confirmed source-kind change. A source path
that is now a symlink or other unsupported entry is treated as obsolete for cleanup, not as a permanent observation
failure. A directory that cannot be read yields no candidates.

`status` separates the active pass, pending follow-up and work status.
`awaitCompletion` includes all admitted passes and required cascades.
`RECONCILE_INTERVAL` retains its production units and validation. Tests can set
`reconcileIntervalMs` at the composition seam to observe the actual owned timer.

```sh
COMPOSE_PROJECT_NAME=opds49-57 bun run rebuild:test
COMPOSE_PROJECT_NAME=opds49-57 docker compose -f docker-compose.test.yml run --rm test bun test test/integration/lifecycle/live-engine-catalogue.test.ts
COMPOSE_PROJECT_NAME=opds49-57 TEST_PORT=18558 docker compose -f docker-compose.e2e.yml up -d --build --wait
COMPOSE_PROJECT_NAME=opds49-57 TEST_BASE_URL=http://localhost:18558 bun test test/e2e/nginx.test.ts
COMPOSE_PROJECT_NAME=opds49-57 docker compose -f docker-compose.e2e.yml down
```

## Freshness

`initialEngineCatalogue(deps, options)`, `openEngineCatalogue(deps, options)`,
`startLiveEngineCatalogue(deps, options)`, `openLiveEngineCatalogue(deps, options)` and
`createLiveEngineLifecycle(deps, options)`
accept `check: "metadata" | "content"` and
`processingVersions: { book?: string, folder?: string }`. OPDS defaults come
from `PROCESSING_VERSIONS` in `src/processing-versions.ts`; bump that constant,
not call-site options, when existing output must rebuild. Change `book` for
extractor/book-entry changes; change `folder` for feed/browser renderer changes.
The engine package version is not a processing version. All compositions use the
exported `engineOptions` declaration.

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
The dev-only `sync-engine-previous` package alias (a packed 0.3.0 archive, immutable) tests a real package upgrade
against real handlers and dated publications. It is a devDependency and is not part of the production image's runtime.

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

## Startup readiness (#56, health #57)

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

Failure map for the first pass, owned by the engine's `recovery` option: without a usable minimum the start
promise rejects and the server exits 1 (the entrypoint passes that status to the container). With a usable
minimum the start promise resolves, nginx keeps serving the previous publication, `errors` holds the pass
failure, and the engine reopens the session in the same scope on `POST /resync`, a watcher notice or a
reconcile tick. Download links are symlinks to the source, so they cannot be served while the source itself is absent.

Deployment health (#57): the image `HEALTHCHECK` and every Compose probe run `healthcheck.sh`. It needs
`"available":true` from Bun's `/status` (read inside the container) and a 200 from nginx for `/feed.xml` and
`/index.html`. A feed without its page is unhealthy. A running verification is healthy once the minimum is
available. `test/e2e/startup-readiness.test.ts` pins the image's declared check and runs it in the cold
(feed-only → unhealthy, minimum → healthy) and warm (prior output during held verification → healthy) scenarios.

`test/e2e/startup-readiness.test.ts` runs the production image (server, nginx, entrypoint) per
scenario. `test/e2e/startup/` holds its Compose overlay: a PATH `unzip` wrapper that holds real
extraction until `gate/hold-unzip` is removed, and a Bun preload that holds one named
`Bun.write` listed in `gate/holds.json`. Both are test-only mounts; the image is unchanged.

```sh
COMPOSE_PROJECT_NAME=opds49-57 STARTUP_PORT=18558 STARTUP_IMAGE=opds49-57-startup bun test test/e2e/startup-readiness.test.ts
```

In-process counterpart: `test/integration/lifecycle/startup-readiness.test.ts`.

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

The engine session uses the package's `acquireOutputTree` lease, acquired and released in an Effect scope.
An open session retains the lease even when its work is complete. A first pass that fails with usable output
releases the lease while the session waits for its retry; the retry acquires it again. Existing handlers keep
interruptible preparation and uninterruptible publication. A failed acquisition starts no scan or publication.

Linux `flock` is supplied by `util-linux` in both Docker images. A child holds
the lock while its stdin remains open. A handshake confirms acquisition before
work starts. Release closes stdin and waits for exit. Bun's death closes the
pipe and releases the lock. Contention waits at most one second, then fails
with `OutputOwnershipFailed`. Canonical output paths share one persistent
`DATA/.sync-engine/lock` inode. Every engine composition explicitly uses this state area. The existing DATA Docker
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

## Update the package

Release path (engine repository, `README.md` "Verify, pack and release"): run its Docker checks, then
`bun scripts/verify-pack.ts` from a clean checkout. It prints the archive hash and lock integrity. Publish that
exact archive with `npm publish <archive> --access public --registry=https://registry.npmjs.org`. npm requires
browser 2FA for the `seigiard` account; a non-TTY publish prints an auth URL and exits `EOTP`, so run the publish
from a TTY pane and let the maintainer confirm in the browser. After publish, compare
`npm view @seigiard/sync-engine@<version> dist.integrity dist.shasum dist.tarball --json --prefer-online` with
the verified archive. The registry can return 404 briefly after a successful publish; retry the view, never
republish the same version.

Consumer update: set the exact version in `package.json`, run the consumer's pinned Bun install to regenerate
`bun.lock`, and rebuild the test and production images. Check that `bun.lock` records the registry tarball integrity,
that `node_modules/@seigiard/sync-engine/package.json` has the version, and that installed package files diff cleanly
against `npm pack @seigiard/sync-engine@<version>`. Run each consumer's gates: OPDS `bun run fix`,
`bun --bun tsc --noEmit`, `bun run test`, `npx knip`, `bun run test:e2e`, and UI freshness checks when UI sources
change; TTRPG host checks, Docker tests and production smoke; OPML lint/type/knip, Docker tests, e2e and
`bun run smoke:engine`. Record counts, lock integrity, package equality, resource gates and limitations in the
consumer evidence.

While preparing an unpublished engine, a content-qualified `file:vendor/…tgz` dependency may stand in. Use a new
basename each time: Bun caches file dependencies by path. Such a build is a candidate, never a release. The
immutable `vendor/seigiard-sync-engine-0.3.0-…tgz` stays: it is the previous-package upgrade fixture.

## Adoption record (#57)

- Release: `@seigiard/sync-engine@0.4.0`, published from engine commit `fb94341ce4fac88798c98fdc73f403dde60356b1` (parent `fac2140`). Archive: 16284 bytes, SHA256 `9b6a6725da04bb9a6a3099c05a14dfcd4ffde13073fd44fb29bd9fc27ce2f087`. Registry `dist.integrity` and `bun.lock` both read `sha512-LQfGhwk0nzKCmI/2BnWyrvaVQxaerDJ8TM4ymPzNeKfmcybHwcIPfft6MDGUtc0CZKj8vciG58FjDCwgzA61yw==`. The installed files, in `node_modules` and in the production image, are byte-identical to that archive.
- `package.json` pins the exact version. The only `file:` dependency left is the dev-only `@seigiard/sync-engine-previous` fixture (SHA256 `06810f27f2e2c05c35fdb520e246dc820c414f0f416d97b93bb687fcc0027a00`).
- The full Docker suite (`COMPOSE_PROJECT_NAME=opds49-57 bun run test`) passed with 0 failures against the registry dependency: 630 pass, 55 files. The count is lower than #56's 707 because the legacy lifecycle, consumer and scanner suites were retired. Their contracts moved as follows.

| Retired suite                                                                                                                                     | Contract                                                                                                                                                             | Owner now                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unit/lifecycle/lifecycle.test.ts`, `transition.test.ts`                                                                                          | Request coalescing with force OR'd; reconciliation timing and the disabled interval; failed resync keeps running; failed first pass fatal or not; restart after stop | Engine `live.test.ts`, `recovery.test.ts`; OPDS `live-engine-catalogue.test.ts`, `startup-readiness.test.ts`                                     |
| `unit/lifecycle/shutdown.test.ts`, `unit/processing/processor-shutdown.test.ts`, `integration/processing/queue-consumer.test.ts` (shutdown cases) | Stop joins active work, drops pending work and cascades, awaits cooperative cleanup                                                                                  | Engine `shutdown.test.ts`; OPDS `engine-shutdown.test.ts`, `engine-signal.test.ts`, the five `*-stop.test.ts` suites on the production lifecycle |
| `unit/processing/catalogue-processor.test.ts`, `queue-consumer.test.ts` (coalescing)                                                              | Pending refresh coalescing; refresh requested while active runs once more; cascade completion; failed work yields no cascade                                         | Engine `work.test.ts`; OPDS `engine-catalogue.test.ts`, `cascade-through-engine.test.ts`                                                         |
| `integration/processing/cascade-through-processor.test.ts`                                                                                        | Folder summary propagation, count changes up to the root, removal refreshes parents                                                                                  | `cascade-through-engine.test.ts` (same six scenarios on the engine session)                                                                      |
| `unit/scanner.test.ts`                                                                                                                            | Folder structure, hash, abort, plan, orphan detection, heap-snapshot housekeeping                                                                                    | Engine `source.test.ts`, `freshness.test.ts`; OPDS `resync-in-place.test.ts` (downtime removals), `legacy-data.test.ts`                          |
| `unit/processing/events.test.ts` dedup case                                                                                                       | Watcher dedup window                                                                                                                                                 | Removed by design: repeated notices pass through; `live-engine-catalogue.test.ts` pins a second replacement during active work                   |
| `initial-engine-catalogue.test.ts` lease-acquisition cases                                                                                        | Lease contention during startup                                                                                                                                      | Same file, on the production lifecycle                                                                                                           |

## Final release evidence (#64 and OPDS review update)

OPDS currently pins `@seigiard/sync-engine@0.5.3`, published from engine commit
`d70a8903d92cdc81ea03a3782b5b821fab4cc165` with registry integrity
`sha512-H0zW/UZlh76lGwdBTK0HU2udFymrdXtHNKUx02LA3KAYYP0WmjnAO8288Efxt6gu4aHbn6ffx1yIsZMN2eLppQ==`. OPDS package equality and gate evidence is recorded inline in `docs/agents/shared-sync-evidence.md`. Changes over `0.5.2`: failed-pass watcher hints and `force` carry into an already queued follow-up; a handler defect in a later live pass rejects further admission and releases the lease; forced/notified requests invalidate active freshness immediately; `undefined` active work item is visible in status; `key`/`failureKey` callback defects settle completion; README release wording.

The common release is `@seigiard/sync-engine@0.5.0`, published from engine commit
`63f4ac1714738ec7e93b117097ab2b88f2ab0150` with registry integrity
`sha512-XN5GY9M3ueBBeaWWRENPCLIwh3Dl0GGPwF06KfgGvpn+WJ/zU0PNXAtfI7PxPk2mpGXJocEw9zKyeMSPXEolRw==`. The #64 scenario matrix,
consumer revisions, commands, installed-package equality checks and delegation audit are in
`docs/agents/shared-sync-evidence.md`.
