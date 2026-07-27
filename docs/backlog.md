# AFK Backlog

This backlog is a working priority list for making AFK a reliable execution layer for agentic repo work.

Trajectory lens:
- AFK is a reusable execution substrate for many repositories.
- Humans, scripts, CI jobs, bots, and higher-level agent frameworks should be able to drive the same core loop.
- The target loop is: work source -> isolated autonomous implementation run -> verification -> PR -> review/follow-up run -> machine-readable status.
- Execution modes are operator profiles for run posture, not free-form personas.
- AFK owns the inner execution loop; humans and orchestrators own the outer loop: constraints, evidence review, verdict, and accountability.
- Autonomy should expand only as far as verification and evidence quality can support it.
- Back pressure is a product feature: AFK should block, narrow, retry, or report failure when evidence is insufficient rather than treating speed as success.

Priority meanings:
- `P0`: next features to build because they materially improve day-to-day usability or reliability
- `P1`: important follow-on features after the current rough edges are removed
- `P2`: valuable extension work once the core loop is stable

## Current Build Order

These are the next features to build in order.

### 1. Land PR comment resolution pass

Why now:
- AFK-generated pull requests should support a second execution pass driven by human review comments
- this closes the loop from implementation run to reviewer-directed follow-up on the same PR

### 2. Machine-readable orchestration contract

Why next:
- AFK's CLI should be usable as a stable backend API for another agent framework, bot, scheduler, or CI workflow
- external orchestrators need structured IDs, URLs, status, run artifacts, and failure reasons without scraping terminal prose

### 3. Explicit backend selection

Why third:
- AFK should make it obvious whether a run is local or remote

### 4. Evidence packet and outer-loop handoff

Why fourth:
- the handoff should make human ownership cheap enough to scale
- operators need a compact evidence boundary: what changed, why it is safe, what failed, and what decision is recommended

### 5. Work admission and back pressure

Why fifth:
- AFK should reject or narrow work before execution when scope, constraints, or verification are too weak
- queue throughput should be controlled by evidence quality, not just agent availability

### 6. Optional GitHub Actions backend

Why sixth:
- once the command contract is stable, GitHub-backed repos can use CI for the cleanest unattended "work source in, PR out" path

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
- `afk cleanup` for safe local artifact pruning
- configurable runner/model selection with separate review model defaults
- bounded autonomous review gate loop

## P0

### 1. Land PR comment resolution pass

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

### 2. Machine-readable orchestration contract

Why:
- AFK should be easy for another agent framework or automation harness to call as a backend worker
- structured command output makes demos, CI integration, and bot workflows deterministic

Scope:
- harden the first `--json` output for the core orchestration commands
- include stable work item ids, run ids, PR URLs, branch names, terminal statuses, worktree paths, and failure reasons
- include `ok` and structured `error.message` fields for failing run/follow-up commands
- keep human-readable output as the default
- cover doctor preflight, errors, and detached/background runs with the same structured contract

### 3. Evidence packet and outer-loop handoff

Why:
- AFK should make the boundary between autonomous work and human decision explicit
- humans should receive enough evidence to decide publish, retry, narrow, or reject without reconstructing the whole run
- non-publishable runs should explain whether the blocker is product behavior, verification coverage, environment setup, review findings, or publishing infrastructure

Scope:
- extend `final-result.json`, `inspect --json`, and `handoff --json` with an evidence packet
- include changed files, commits, verification commands and outcomes, review verdicts, addressed issues, remaining risks, and recommended human action
- separate product failures from environment/setup failures in `whyNotPublishable`
- include an "understanding brief" for reviewers: key files changed, important design decisions, and what to inspect first
- keep the compact handoff useful for bots while preserving richer diagnostics in inspect/final artifacts

Notes:
- this operationalizes the "lit factory" boundary: AFK can run the inner loop, but the operator owns the outer-loop verdict
- evidence quality should be treated as a prerequisite for publishing, not as optional run commentary

## P1

### 4. Explicit backend selection

Why:
- AFK should make it obvious whether a run is local or remote
- external orchestrators need predictable dispatch behavior

Scope:
- harden the first `--backend local-docker` selector on run and follow-up commands
- keep the configured default in `execution.backend`
- report the resolved backend in JSON command output
- leave unsupported remote backend names invalid until those backends exist

### 5. Work admission and back pressure

Why:
- agents can produce more output than humans can review
- brownfield tasks with weak context or missing checks should not enter the same queue as well-scoped, cheaply verifiable work
- AFK should make orchestration tax visible before a run consumes time

Scope:
- classify incoming work before execution: `ready`, `needs_constraints`, `needs_tests`, `too_large`, or `blocked_by_environment`
- require or recommend verification commands for non-trivial code changes
- surface missing evidence as a queue/back-pressure reason instead of discovering it only after implementation
- time-box unactionable work and ask for a narrower brief when scope expands
- report queue health with counts by admission status and blocker reason

Notes:
- this is not a replacement for human judgment; it is a way to route attention to the right decisions earlier
- successful automation should reduce comprehension debt by producing smaller, better-evidenced changes

### 6. Optional GitHub Actions backend

Why:
- for GitHub-backed repos, the cleanest unattended path is often “issue in, PR out” from CI instead of the local machine

Scope:
- harden the first manual `workflow_dispatch` harness for "issue URL in, PR out"
- expose an init flag for installing the GitHub Actions harness in target repos
- make the GitHub Actions harness check out AFK Geoff instead of requiring target repos to install the CLI
- expose a CLI workflow dispatch command for external orchestrators
- publish machine-readable workflow artifacts for preflight and run results
- expose a CLI command for listing recent remote workflow runs
- expose a CLI command for listing artifacts from a remote workflow run
- expose a CLI command for downloading remote workflow artifacts
- define how local SQLite state and remote workflow state should reconcile
- then add a remote execution backend behind the existing execution backend port
- keep local Docker execution as the portable default

## P2

### 7. More source adapters

Candidates:
- GitLab issue source
- Azure DevOps work item source
- Bitbucket source
- Linear issue source
- Slack command source
- GitHub App webhook source

### 8. More publishing adapters

Candidates:
- GitLab merge request publisher
- Bitbucket pull request publisher
- local patch or branch summary publisher

### 9. More execution backends

Candidates:
- GitLab CI
- Azure Pipelines
- CircleCI

### 10. Runner usage accounting

Why:
- token and cost visibility can be useful, but it should not block core usability work

Scope:
- capture token usage only if the configured runner exposes it reliably

### 11. Comprehension debt tracking

Why:
- autonomous runs can widen the gap between code produced and code understood
- teams need lightweight signals that show when generated changes are becoming expensive to own

Scope:
- track change size, touched ownership areas, review iterations, and verification gaps as comprehension-risk signals
- include comprehension-risk notes in handoff artifacts for medium/high-risk runs
- prefer smaller follow-up briefs when a run crosses configurable size or complexity thresholds
