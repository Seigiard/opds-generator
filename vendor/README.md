# Local engine package

Content-qualified engine tarballs are packed releases from the separate
`Seigiard/sync-engine` repository. `package.json` selects the runtime release.
The dev-only previous-release alias is an independent upgrade fixture for the
freshness integration test. These artifacts are not npm publications.

Runtime 0.3.1 is packed from merged engine commit
`5f841e4` on `spec/49-ticket-52`, including recovery, state ownership, freshness, live scheduling and shutdown.
The separate packed 0.3.0 archive is immutable. Keep it and its lock integrity
when replacing the runtime archive.
