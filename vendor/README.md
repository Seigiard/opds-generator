# Local engine package

Content-qualified engine tarballs are packed releases from the separate
`Seigiard/sync-engine` repository. `package.json` selects the runtime release.
The dev-only previous-release alias is an independent upgrade fixture for the
freshness integration test. These artifacts are not npm publications.

Runtime 0.3.1 is packed from merged engine commit
`2aef9fbc810430db65205852e8e848574c61b19f`, including freshness and live scheduling.
The separate packed 0.3.0 archive is immutable. Keep it and its lock integrity
when replacing the runtime archive.
