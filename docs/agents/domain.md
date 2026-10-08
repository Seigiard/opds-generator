# Domain Docs

This repository uses a single-context layout.

## Before exploring

Read the root `GLOSSARY.md` for domain terms.
Read ADRs in `docs/adr/` that apply to the area you will work on.

If these documents do not exist, proceed silently.
`/domain-modeling` creates them when terms or decisions are resolved.

## Layout

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/NNNN-short-title.md`: architecture decision records.

## Use the glossary's vocabulary

Use glossary terms when naming domain concepts in issues, proposals,
hypotheses, code, and tests.

If a term is missing, check whether an existing term fits.
Record a real vocabulary gap for `/domain-modeling`.

## Shared engine target

For shared-engine extraction or migration, read [ADR 0004](../adr/0004-shared-synchronization-engine.md) and the [target contract](../plans/shared-synchronization-engine.md). They record the agreed cross-application design. OPDS runs on it since #57; TTRPG Map Viewer and OPML Generator do not yet. Keep **Available**, **Verifying**, **Completed** and retained errors distinct, as the glossary and `GET /status` do.

## Surface ADR conflicts

If a proposal contradicts an existing ADR, name that ADR and explain
why the decision should be reconsidered.
