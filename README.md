# afk-geoff

AFK orchestration CLI for turning captured requirements into tracked work runs with local artifacts and optional GitHub mirroring.

## Quick Start

```bash
git init -b main
pnpm install
pnpm afk init
```

This creates:

- `.afk/config.yaml`
- `.afk/.gitignore`
- `.afk/iteration-loop.md`
- `.afk/state.sqlite`
- `.afk/runs/`
- `.afk/worktrees/`

## Safe First Workflow

Start with one work item at a time and keep the loop human-reviewed:

1. Capture a requirement.
2. Create an execution brief with your preferred planning skill.
3. Run one AFK item with `run file` or inspect queue state with `status` and `show`.
4. Inspect artifacts with `runs` and `logs`.
5. Review the worktree and branch before merging anything.

Suggested command flow:

```bash
pnpm afk capture "Describe a small internal improvement"
pnpm afk run file brief.md --pr
pnpm afk status
pnpm afk show <requirement-id>
pnpm afk runs
pnpm afk logs <run-id>
```

## GitHub-Backed Setup

Once the repo has a GitHub remote:

1. Add an `origin` remote.
2. Export `GH_TOKEN`.
3. Ensure the configured runner auth env vars are set.
4. Run `pnpm afk doctor`.

## Useful Commands

- `pnpm afk doctor`
- `pnpm afk status`
- `pnpm afk show <id>`
- `pnpm afk runs`
- `pnpm afk logs <run-id>`
- `pnpm afk review <work-item-id>`

## Guardrails

- SQLite remains the source of truth.
- GitHub is a mirror and collaboration surface.
- HITL work is not auto-dispatched.
- `result.json` is the authoritative worker result.
- Run artifacts are retained for debugging.

## Developer Docs

- [BDD scenarios](/Users/davidneil/Development/Personal/afk-geoff/docs/bdd/scenarios.md)
- [Ubiquitous language](/Users/davidneil/Development/Personal/afk-geoff/docs/ubiquitous-language.md)
- [Backlog](/Users/davidneil/Development/Personal/afk-geoff/docs/backlog.md)
