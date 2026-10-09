# Local engine packages

`package.json` selects the runtime engine from the npm registry. This directory only keeps compatibility archives used
by tests.

`seigiard-sync-engine-0.3.0-59ec12f16880982f00d7af78de771e885f4022cb.tgz` is a packed 0.3.0 archive. It is the
dev-only `@seigiard/sync-engine-previous` alias that `engine-freshness.test.ts` installs to test a real
package upgrade against real handlers. Keep it and its lock integrity. It is not a runtime dependency and is not part
of the production image's installed packages.

The procedure to update the runtime package from the registry is in `docs/agents/shared-sync-engine.md`.
