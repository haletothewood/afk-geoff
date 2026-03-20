# Dogfooding This Repo

This repo is ready for a controlled dogfooding rollout.

## Recommended Rollout

Start with one work item at a time and keep the loop human-reviewed:

1. capture a requirement
2. plan it
3. approve it
4. inspect the queue with `status` and `show`
5. run one AFK item with `run`
6. inspect artifacts with `runs` and `logs`
7. review the worktree and branch before merging anything

Do not start with broad unattended `dispatch` across multiple items until the real GitHub path and failure-path behavior have been exercised in this repo.

## Local-First Setup

If the repo has not been initialized yet:

```bash
git init -b main
pnpm aiwf init
```

This creates:

- `.ai-workflows/config.yaml`
- `.ai-workflows/.gitignore`
- `.ai-workflows/state.sqlite`
- `.ai-workflows/runs/`
- `.ai-workflows/worktrees/`

## GitHub-Backed Setup

Once the repo has a GitHub remote:

1. add an `origin` remote
2. export `GH_TOKEN`
3. ensure the configured runner auth env vars are set
4. run `pnpm aiwf doctor`

The default config enables GitHub mirroring, so `doctor` is the quickest way to verify the repo is ready for a live run.

## Safe First Workflow

Use a small internal requirement first. Good examples:

- improve failure handling when a worker does not produce `result.json`
- add richer run inspection commands
- tighten GitHub sync behavior around closed PRs

Suggested command flow:

```bash
pnpm aiwf capture "Describe a small internal improvement"
pnpm aiwf plan <requirement-id>
pnpm aiwf approve <requirement-id>
pnpm aiwf status
pnpm aiwf show <requirement-id>
pnpm aiwf run <work-item-id>
pnpm aiwf runs
pnpm aiwf logs <run-id>
```

## Commands Most Useful During Dogfooding

- `pnpm aiwf doctor`
- `pnpm aiwf status`
- `pnpm aiwf show <id>`
- `pnpm aiwf runs`
- `pnpm aiwf logs <run-id>`
- `pnpm aiwf review <work-item-id>`

## Current Guardrails

- SQLite remains the source of truth.
- GitHub is a mirror and collaboration surface.
- HITL work is not auto-dispatched.
- `result.json` is the authoritative worker result.
- Run artifacts are retained for debugging.
