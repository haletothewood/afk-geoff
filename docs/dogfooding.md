# Dogfooding This Repo

This repo is ready for a controlled dogfooding rollout.

## Recommended Rollout

Start with one work item at a time and keep the loop human-reviewed:

1. capture a requirement
2. create an execution brief with your preferred planning skill
3. run one AFK item with `run file` or inspect the queue with `status` and `show`
4. inspect artifacts with `runs` and `logs`
5. review the worktree and branch before merging anything

Do not start with broad unattended `dispatch` across multiple items until the real GitHub path and failure-path behavior have been exercised in this repo.

## Local-First Setup

If the repo has not been initialized yet:

```bash
git init -b main
pnpm afk init
```

This creates:

- `.afk/config.yaml`
- `.afk/.gitignore`
- `.afk/state.sqlite`
- `.afk/runs/`
- `.afk/worktrees/`

## GitHub-Backed Setup

Once the repo has a GitHub remote:

1. add an `origin` remote
2. export `GH_TOKEN`
3. ensure the configured runner auth env vars are set
4. run `pnpm afk doctor`

The default config enables GitHub mirroring, so `doctor` is the quickest way to verify the repo is ready for a live run.

## Safe First Workflow

Use a small internal requirement first. Good examples:

- improve failure handling when a worker does not produce `result.json`
- add richer run inspection commands
- tighten GitHub sync behavior around closed PRs

Suggested command flow:

```bash
pnpm afk capture "Describe a small internal improvement"
pnpm afk run file brief.md --pr
pnpm afk status
pnpm afk show <requirement-id>
pnpm afk runs
pnpm afk logs <run-id>
```

## Commands Most Useful During Dogfooding

- `pnpm afk doctor`
- `pnpm afk status`
- `pnpm afk show <id>`
- `pnpm afk runs`
- `pnpm afk logs <run-id>`
- `pnpm afk review <work-item-id>`

## Current Guardrails

- SQLite remains the source of truth.
- GitHub is a mirror and collaboration surface.
- HITL work is not auto-dispatched.
- `result.json` is the authoritative worker result.
- Run artifacts are retained for debugging.
