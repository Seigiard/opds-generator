# Local engine package

Content-qualified engine tarballs are packed releases from the separate
`Seigiard/sync-engine` repository. `package.json` selects the runtime release.
The dev-only previous-release alias is an independent upgrade fixture for the
freshness integration test. These artifacts are not npm publications.

Runtime 0.3.1 is packed from engine commit
`fac2140` on `spec/49-ticket-56`, including recovery, state ownership, freshness, live scheduling, shutdown
and minimum-publication readiness (`minimum`, `onMinimum`, `LiveStatus.failure`).
The separate packed 0.3.0 archive is immutable. Keep it and its lock integrity
when replacing the runtime archive.
