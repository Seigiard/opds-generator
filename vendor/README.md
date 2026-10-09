# Local engine packages

`package.json` normally selects the runtime engine from the npm registry. During the round 4 and round 5 review loop it
temporarily selects a local runtime tarball from this directory.

`seigiard-sync-engine-0.3.0-59ec12f16880982f00d7af78de771e885f4022cb.tgz` is a packed 0.3.0 archive. It is the
dev-only `@seigiard/sync-engine-previous` alias that `engine-freshness.test.ts` installs to test a real
package upgrade against real handlers. Keep it and its lock integrity. It is not a runtime dependency and is not part
of the production image's installed packages.

`seigiard-sync-engine-0.5.4.tgz` is a temporary runtime tarball pin for the round 4 review loop. Replace it with the
registry release before merge.

The procedure to update the runtime package is in `docs/agents/shared-sync-engine.md`.
