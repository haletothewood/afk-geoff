# AFK Backlog

This backlog is a working priority list for making AFK reliable enough to dogfood regularly.

Priority meanings:
- `P0`: next features to build because they materially improve day-to-day usability or reliability
- `P1`: important follow-on features after the current rough edges are removed
- `P2`: valuable extension work once the core loop is stable

## Current Build Order

These are the next three features to build in order.

### 1. Live run progress and heartbeat

Why now:
- it fixes the biggest current usability gap: active runs are too opaque
- it creates the foundation for both timeout handling and watch mode

### 2. Run timeouts and heartbeat expiry

Why next:
- once heartbeat exists, AFK can fail hung runs predictably
- this is the core reliability guardrail for unattended execution

### 3. `afk watch <runId>`

Why third:
- once progress and heartbeat exist, watch mode becomes straightforward and genuinely useful
- it gives the operator a clean monitoring surface without changing the execution model

## Recently Landed

- `run file <path>` execution path
- `run file <path> --pr` one-shot branch and PR flow
- ports/adapters refactor for work sources, execution backends, and result publishers
- `run issue <github-issue-url>` as a work source

## P0

### 1. Live run progress and heartbeat

Why:
- A running job is currently opaque beyond stdout/stderr
- The operator should be able to tell whether a worker is alive, what phase it is in, and whether it is making progress

Scope:
- have the worker write `/afk-run/progress.json` periodically
- include at least `phase`, `message`, `iteration`, and `updatedAt`
- show active progress in `afk status` and `afk show <work-item-id>`

Notes:
- token accounting is optional and should only be included if the runner exposes it cheaply

### 2. Run timeouts and heartbeat expiry

Why:
- a hung worker should fail predictably instead of leaving an item in `running` or `in_progress`

Scope:
- add per-run timeout configuration
- fail runs when heartbeat or progress updates go stale
- record a clear failure summary for timeout versus ordinary worker failure

### 3. `afk watch <runId>`

Why:
- operators need a clean way to follow a live job without manually reopening `logs`

Scope:
- stream `stdout.log`, `stderr.log`, and `progress.json`
- show the current phase and iteration while the run is active

### 4. PR/auth preflight hardening

Why:
- `--pr` should fail fast before spending time on a long run if push or PR auth is broken

Scope:
- verify remote configuration up front
- verify GitHub token state up front
- distinguish SSH push failures from GitHub API failures in user-facing output

## P1

### 5. Configurable model selection and runner presets

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

### 6. Structured PR bodies with manual QA guidance

Why:
- a successful AFK run should open a reviewable PR, not just a diff
- reviewers should get a consistent summary of what changed, what was verified automatically, and how to manually QA the work

Scope:
- define a standard PR body structure
- include at least summary, automated verification, manual QA steps, and notable risks or follow-ups
- make manual QA instructions part of the worker result contract so the publisher can render them consistently
- keep the final PR body shape predictable across runs

### 7. Optional GitHub Actions backend

Why:
- for GitHub-backed repos, the cleanest unattended path is often “issue in, PR out” from CI instead of the local machine

Scope:
- add a remote execution backend behind the existing execution backend port
- keep local Docker execution as the portable default

### 8. Source-aware run updates

Why:
- imported GitHub issues should receive useful progress or completion comments without the CLI having to special-case them inline

Scope:
- publish final run summaries back to the source issue when appropriate
- later extend to progress comments or status notes

### 9. Cleanup command

Why:
- local dogfooding leaves runs, worktrees, and state artifacts behind

Scope:
- add a supported command to prune local run artifacts safely

### 10. Explicit backend selection

Why:
- AFK should make it obvious whether a run is local or remote

Scope:
- support an explicit backend selector instead of burying environment-specific behavior in flags

### 11. Undo open AFK PRs and branches

Why:
- AFK should have a safe rollback path for its own unmerged work without asking the operator to manually clean up Git state and local ledger state

Scope:
- only support undo for AFK-created pull requests and branches
- only support the open, unmerged case
- close the open PR
- optionally delete the branch
- mark the local work item and run state appropriately

Non-goals:
- no automatic revert flow for merged PRs
- no history rewriting
- no attempt to undo non-AFK or manually-created PRs

## P2

### 12. More source adapters

Candidates:
- GitLab issue source
- Azure DevOps work item source
- Bitbucket source

### 13. More publishing adapters

Candidates:
- GitLab merge request publisher
- Bitbucket pull request publisher
- local patch or branch summary publisher

### 14. More execution backends

Candidates:
- GitLab CI
- Azure Pipelines
- CircleCI

### 15. Runner usage accounting

Why:
- token and cost visibility can be useful, but it should not block core usability work

Scope:
- capture token usage only if the configured runner exposes it reliably
