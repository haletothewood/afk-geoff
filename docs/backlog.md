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
- it creates the foundation for timeout handling, watch mode, and safe background execution

### 2. Run timeouts and heartbeat expiry

Why next:
- once heartbeat exists, AFK can fail hung runs predictably
- this is the core reliability guardrail for unattended execution

### 3. Detached background execution

Why third:
- once progress and timeout handling exist, AFK can safely run in the background without trapping the operator in a blocked terminal
- this unlocks the actual “carry on with other things” workflow the product is aiming for

## Recently Landed

- `run file <path>` execution path
- `run file <path> --pr` one-shot branch and PR flow
- ports/adapters refactor for work sources, execution backends, and result publishers
- `run issue <github-issue-url>` as a work source
- standardized PR bodies with manual QA guidance
- `afk undo` for open AFK PRs and branches

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

### 3. Detached background execution

Why:
- AFK runs should not force the operator to keep a foreground terminal blocked for long-running work
- background mode becomes much more usable once heartbeat and timeout handling exist

Scope:
- add `--detach` support for `afk run ...`
- return immediately with the run id and clear follow-up commands
- persist enough process metadata to support later watch and cancel flows
- fail clearly if AFK cannot keep the run alive after detaching

Notes:
- keep foreground mode as the default for debugging and short runs

### 4. `afk watch <runId>`

Why:
- operators need a clean way to follow a live job without manually reopening `logs`

Scope:
- stream `stdout.log`, `stderr.log`, and `progress.json`
- show the current phase and iteration while the run is active

### 5. PR/auth preflight hardening

Why:
- `--pr` should fail fast before spending time on a long run if push or PR auth is broken

Scope:
- verify remote configuration up front
- verify GitHub token state up front
- distinguish SSH push failures from GitHub API failures in user-facing output

## P1

### 6. Configurable model selection and runner presets

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

### 7. PR comment resolution pass

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

### 8. Optional GitHub Actions backend

Why:
- for GitHub-backed repos, the cleanest unattended path is often “issue in, PR out” from CI instead of the local machine

Scope:
- add a remote execution backend behind the existing execution backend port
- keep local Docker execution as the portable default

### 9. Explicit backend selection

Why:
- AFK should make it obvious whether a run is local or remote

Scope:
- support an explicit backend selector instead of burying environment-specific behavior in flags

### 10. Source-aware run updates

Why:
- imported GitHub issues should receive useful progress or completion comments without the CLI having to special-case them inline

Scope:
- publish final run summaries back to the source issue when appropriate
- later extend to progress comments or status notes

### 11. Cleanup command

Why:
- local dogfooding leaves runs, worktrees, and state artifacts behind

Scope:
- add a supported command to prune local run artifacts safely

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
