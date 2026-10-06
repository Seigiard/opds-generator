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

## Surface ADR conflicts

If a proposal contradicts an existing ADR, name that ADR and explain
why the decision should be reconsidered.
