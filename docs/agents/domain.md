# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence or suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions are resolved.

## File structure

This repository uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
└── packages/
```

If a root `CONTEXT-MAP.md` is introduced later, follow it to the relevant context-specific documentation instead.

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the required concept is not in the glossary, reconsider whether it belongs to the project language or note the gap for `/grill-with-docs`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly instead of silently overriding it.
