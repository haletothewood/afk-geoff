# AFK Geoff

> A boringly reliable execution layer for autonomous coding agents.

AFK Geoff turns a repository work brief into an isolated implementation run, verified changes, an independent review, and a machine-readable handoff. It is designed to be driven by humans, scripts, CI jobs, bots, or higher-level agent frameworks.

AFK is not another coding agent. It provides the execution loop around agents such as Codex, Claude, or a custom CLI runner.

## What it can do

- accept work from a local brief or mirrored GitHub issue
- run changes in an isolated Git branch and worktree
- invoke configurable implementation and review runners
- execute project-specific verification commands
- run a bounded review-and-fix loop
- retain progress, logs, verification evidence, and final results under `.afk/`
- stream machine-readable lifecycle events for external orchestrators
- publish an optional pull request
- apply review feedback to the existing pull-request branch
- run locally in the foreground or as a detached background process

AFK blocks or reports a non-publishable result when verification, review, repository state, or publishing requirements are not satisfied. `final-result.json` is the authoritative completion artifact.

## Quick start

AFK requires Node.js 22 or newer and a Git repository.

Initialize it with a local Codex runner:

```bash
pnpm dlx afk-geoff init --runner-profile codex
pnpm dlx afk-geoff doctor
```

Or use Claude:

```bash
pnpm dlx afk-geoff init --runner-profile claude
pnpm dlx afk-geoff doctor
```

Create a brief such as `brief.md`, then start an isolated run:

```bash
pnpm dlx afk-geoff run file brief.md --detach --json
```

Watch it and retrieve the final handoff:

```bash
pnpm dlx afk-geoff watch <run-id> --json
pnpm dlx afk-geoff handoff <run-id> --json
```

If verification repeatedly failed on a reviewed, unchanged commit because of an external condition, correct that condition and retry only verification:

```bash
pnpm dlx afk-geoff retry <run-id> --stage verification --json
```

AFK refuses this recovery if the reviewed commit changed or the worktree is dirty.

Use `--pr` on the run command when the result should be published as a pull request.

For a repo-local installation:

```bash
pnpm add -D afk-geoff
pnpm afk init --runner-profile codex
```

## Execution model

```text
brief or issue
    ↓
isolated branch and worktree
    ↓
implementation runner
    ↓
project verification plus execution-brief verification
    ↓
independent review
    ↓
fix and re-verify when needed
    ↓
structured handoff or pull request
```

The outer orchestrator or human remains responsible for choosing the work, reviewing the evidence, and deciding whether to publish, retry, narrow, or reject the result.

## Roadmap

The next priorities are:

1. Continue hardening the pull-request comment resolution contract for reviewer-directed follow-up runs.
2. Stabilize and document the machine-readable orchestration contract.
3. Harden run lifecycle and worktree ownership for reliable detached and concurrent execution.

After that, planned work includes stronger work admission and back pressure, hardened backend selection, the optional GitHub Actions backend, additional source and publishing adapters, and reliable runner usage accounting.

Roadmap order may change as the execution contract is tested in real repositories. See the [public roadmap](https://github.com/haletothewood/afk-geoff/blob/main/docs/roadmap.md) for current direction.

## Current status

AFK Geoff is early-stage software. Local execution is the primary workflow, GitHub Actions support is experimental, and human review is recommended before merging generated changes.

## Documentation

- [Repository and full documentation](https://github.com/haletothewood/afk-geoff)
- [Agent orchestrator quick start](https://github.com/haletothewood/afk-geoff/blob/main/docs/agent-orchestrator-quickstart.md)
- [Machine-readable orchestrator contract](https://github.com/haletothewood/afk-geoff/blob/main/docs/orchestrator-contract.md)
- [Public roadmap](https://github.com/haletothewood/afk-geoff/blob/main/docs/roadmap.md)

## License

See the repository for licensing information.
