# AFK Backlog

This backlog is a working priority list for making AFK reliable enough to dogfood regularly.

Trajectory lens:
- AFK is a reusable orchestrator for many repositories.
- The target loop is: HITL planning -> autonomous implementation run -> PR -> HITL review/follow-up run (potentially with a different runner/model profile).
- Execution modes are operator profiles for run posture, not free-form personas.

Priority meanings:
- `P0`: next features to build because they materially improve day-to-day usability or reliability
- `P1`: important follow-on features after the current rough edges are removed
- `P2`: valuable extension work once the core loop is stable

## Current Build Order

These are the next three features to build in order.

### 1. Cleanup command

Why now:
- repeated dogfooding leaves runs and worktrees behind
- cleanup reduces local operational drag and makes it cheaper to recover from failed experiments

### 2. Configurable model selection and runner presets

Why next:
- the operator should be able to choose the cost/capability tradeoff for each run
- implementation and review phases should be able to use different runner/model defaults

### 3. PR comment resolution pass

Why third:
- AFK-generated pull requests should support a second execution pass driven by human review comments
- this closes the loop from implementation run to reviewer-directed follow-up on the same PR

## Recently Landed

- live run progress and heartbeat
- run timeouts and heartbeat expiry
- detached background execution
- execution preflight hardening
- source-aware run updates
- `run file <path>` execution path
- `run file <path> --pr` one-shot branch and PR flow
- execution-mode inference and explicit mode resolution in worker prompts
- dependency bootstrap inside the worker container
- ports/adapters refactor for work sources, execution backends, and result publishers
- `run issue <github-issue-url>` as a work source
- standardized PR bodies with manual QA guidance
- `afk undo` for open AFK PRs and branches
- `afk watch <runId>` for live run visibility

## P0

### 1. Cleanup command

Why:
- local dogfooding leaves runs, worktrees, and state artifacts behind
- there should be a safe supported way to prune old artifacts without manual surgery

Scope:
- add a supported command to prune local run artifacts safely
- distinguish active runs from removable historical artifacts
- make it easy to clean old worktrees and runs without damaging current execution state

## P1

### 2. Configurable model selection and runner presets

Why:
- the operator should be able to choose the cost/capability tradeoff for a run instead of accepting a hidden default
- Claude-backed runs in particular should be able to target models like Opus, Sonnet, or Haiku when the runner supports it

Scope:
- add a configurable default model in AFK config
- support runner-specific model selection where the underlying CLI supports it
- leave room for per-run overrides later without coupling the CLI to one vendor
- fail clearly when a configured model is not supported by the selected runner

Notes:
- the abstraction should be “model preference” or “model id”, not Claude-only naming in the core

### 3. PR comment resolution pass

Why:
- AFK-generated pull requests should support a second execution pass driven by human review comments
- this creates a practical reviewer loop instead of forcing the operator to manually translate comments back into a new brief

Scope:
- ingest unresolved review comments from an open pull request
- run against the existing PR branch rather than creating a new branch
- push follow-up commits to the same PR
- report what comments were addressed and what verification ran

Notes:
- scope the first version to AFK-created pull requests
- do not auto-resolve comments in the first version

### 4. Optional GitHub Actions backend

Why:
- for GitHub-backed repos, the cleanest unattended path is often “issue in, PR out” from CI instead of the local machine

Scope:
- add a remote execution backend behind the existing execution backend port
- keep local Docker execution as the portable default

### 5. Explicit backend selection

Why:
- AFK should make it obvious whether a run is local or remote

Scope:
- support an explicit backend selector instead of burying environment-specific behavior in flags

## P2

### 6. More source adapters

Candidates:
- GitLab issue source
- Azure DevOps work item source
- Bitbucket source

### 7. More publishing adapters

Candidates:
- GitLab merge request publisher
- Bitbucket pull request publisher
- local patch or branch summary publisher

### 8. More execution backends

Candidates:
- GitLab CI
- Azure Pipelines
- CircleCI

### 9. Runner usage accounting

Why:
- token and cost visibility can be useful, but it should not block core usability work

Scope:
- capture token usage only if the configured runner exposes it reliably
