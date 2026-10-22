# Project profile: opds-generator

## What the software is

- A self-hosted OPDS 1.2 catalogue generator for local ebooks. One maintainer, published as a public Docker image (`ghcr.io/seigiard/opds-generator`); users run it at home against their own book folder.
- Bun + TypeScript, nginx in front, everything in Docker. `/books` is mounted read-only; `/data` mirrors it with `feed.xml`, `_entry.xml`, `entry.xml`, covers and a `file` symlink per book.
- Synchronization (scans, scheduling, reconciliation, freshness, retry, shutdown) is the external package `@seigiard/sync-engine` (ADR 0004). This repo owns extraction (`src/formats/`), Effect 4 handlers (`src/processing/`), rendering (`src/render/`), lifecycle wiring (`src/lifecycle/`, `src/server.ts`) and the browser viewer/reader (`ui/`, built into committed `static/`).
- Clients: OPDS reader apps read `feed.xml`; the browser view is a static SPA that fetches and renders the same `feed.xml` (ADR 0005).

## What a real failure looks like here

- The catalogue goes offline or loses entries: `feed.xml` missing (nginx answers 503), a resync or scan that wipes `/data`, or cleanup that deletes output after a source _read failure_ (a read failure is never deletion; ADR 0001).
- A book or folder silently missing from its parent feed, a wrong or broken download/cover link, or stale output after a change that should have bumped `PROCESSING_VERSIONS` (`src/processing-versions.ts`).
- Any write under `/books`, or a handler write that feeds the watcher back.
- Shutdown or cancellation that leaves an external command (`pdftoppm`, `ddjvu`, `unzip`, `7z`) running, leaks a temp dir or fd, or publishes a half-written entry.
- Untrusted book content reaching a shell command as an option (entry paths starting with `-`) or reaching HTML unescaped in the viewer/reader.
- Memory growth per book on large libraries (memory gates in `test/helpers/leak-probe.ts`).
- A test that cannot go red: expected values copied from the patch, a mock that answers its own assertion, a dropped failure path.

## Blast radius

- One household's library per deployment, but the image is public: a regression ships to every user who pulls `latest`.
- Libraries can hold tens of thousands of books; per-book cost and memory matter, per-request micro-optimisation does not.
- No accounts, no multi-tenant data. Auth is nginx Basic Auth on admin routes only.

## Reporting bar

- Report defects that make the catalogue wrong, unavailable, unsafe, or that leak resources, and tests that would stay green when the behavior breaks.
- Report a deviation from a documented rule in `AGENTS.md` or `docs/agents/*.md` (see below).
- Do not report style preferences already enforced by `oxfmt`/`oxlint`, missing configurability, or abstractions for single-use code.
- Do not report missing tests for behavior owned by an upstream system (`@seigiard/sync-engine`, opds-ts, external CLIs) or for agent-facing prose.
- Treat failures listed in `docs/known-flaky-tests.md` as flaky, not regressions.

## Where the rules live

- `AGENTS.md` (`CLAUDE.md` is a symlink) — project map, always-on rules, topic pointers.
- `docs/agents/*.md` — development and finishing gates, processing, lifecycle, external commands, formats, viewer, reader, configuration, shared sync engine.
- `docs/adr/0001`–`0005`, `GLOSSARY.md` — domain decisions and vocabulary.
- `.oxlintrc.json` — project and vendored anti-slop lint rules; `tools/oxlint/opds/` holds project rules.

## Deliberate conventions (not defects)

- `static/` and `test/golden/*` are generated and committed; review their sources, not the output.
- `src/render/*` and `src/types.ts` stay browser-importable: no node builtins, no `Bun` globals.
- Effect↔Promise crossing goes through `src/utils/owned-promise.ts`; direct `Effect.runPromise` in source is linted out (`opds/no-direct-effect-promise`). Test helpers may run Effects directly.
- Cancellation is fiber interruption, not an error value; handlers mark only cancellable phases `Effect.interruptible`.
- Tests run in Docker (`bun run test`); integration tests need tools from the test image.
- `tools/oxlint/anti-slop/` is vendored; its upstream text is not this project's style.
- Historical mentions of removed libraries in ADRs and `UPSTREAM.md` stay.

## Languages

- TypeScript (Bun) for app, tests and UI; shell for `src/watcher.sh`, `entrypoint.sh`, `healthcheck.sh`; nginx config template; Markdown docs in English.
