# Shared synchronization engine: catalogue dependencies (#50–#51)

The separate repository is `Seigiard/sync-engine`. OPDS locks a local packed
`@seigiard/sync-engine@0.2.0` artifact in `vendor/`. It is not published to npm.
Its exact `effect@4.0.1` peer uses OPDS's runtime; Effect is not bundled.

## Reproduce

```sh
bun install --frozen-lockfile
git submodule update --init
COMPOSE_PROJECT_NAME=opds49-51 bun run rebuild:test
COMPOSE_PROJECT_NAME=opds49-51 docker compose -f docker-compose.test.yml run --rm test bun test test/integration/lifecycle/initial-engine-catalogue.test.ts test/integration/lifecycle/engine-catalogue.test.ts
COMPOSE_PROJECT_NAME=opds49-51 docker compose -f docker-compose.test.yml down
```

The tests use temporary trees, production filesystem services and all existing
format registrations. They verify metadata, covers, browser and feed output,
unchanged source bytes, download targets, nested cascades and completion while
required downstream publication is held.

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
Effect handlers. Other event kinds remain outside this temporary composition.

The engine combines pending work only for OPDS-declared folder-refresh keys.
A repeated pending refresh moves behind intervening work. A refresh requested
while equivalent work is active schedules one pending follow-up. Handler-returned
cascades enter pending work before active clears. `status.state` stays `working`
until required cascades publish; `complete` means work completion, not freshness.
A handler failure currently ends the scheduler and fails the completion wait.
Failure recovery is a later slice.

OPDS owns the propagation rule: a book refreshes its folder, and folder summaries
propagate to the parent only when `_entry.xml` changes without its timestamp.
Each folder still writes its own feed. A book's symlink exists before its entry
is published. A new folder publishes its child feed before `_entry.xml`, so a
parent cannot publish a reference to a missing child feed. Publication is gradual.

## Output ownership

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
`.sync-engine.lock` inode. Keep that inode in the dedicated output area;
unlinking it while an owner runs permits a second lock identity.

The engine requires disjoint source/output trees and excludes source symlinks.
Read errors fail the initial pass instead of publishing an empty replacement.
Handler failures prevent final publication and release ownership. This slice
has no engine watcher, freshness, resync or reconciliation.

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
