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

### 1. Harden verification and incremental recovery

Why now:
- malformed or ambiguous verification instructions can currently waste worker/reviewer iterations and produce unrelated repository changes
- verifier and orchestration failures must not be treated as product-code failures
- reviewed implementation evidence should be reusable when only verification or finalization needs to be retried

### 2. Finish PR comment resolution pass

Why now:
- AFK-generated pull requests should support a second execution pass driven by human review comments
- this closes the loop from implementation run to reviewer-directed follow-up on the same PR
- the remaining gap is documenting the follow-up contract and deciding whether follow-up should inherit brief-local verification

### 3. Finish machine-readable orchestration contract

Why next:
- AFK's CLI should be usable as a stable backend API for another agent framework, bot, scheduler, or CI workflow
- external orchestrators need structured IDs, URLs, status, run artifacts, and failure reasons without scraping terminal prose
- the remaining gap is documenting and freezing the command contract once the envelopes are consistent

### 4. Work admission and back pressure

Why next:
- AFK should reject or narrow work before execution when scope, constraints, or verification are too weak
- queue throughput should be controlled by evidence quality, not just agent availability

### 5. Explicit backend selection

Why next:
- AFK should make it obvious whether a run is local or remote

### 6. Optional GitHub Actions backend

Why later:
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
- evidence packet and outer-loop handoff in `final-result.json`, `inspect --json`, and `handoff --json`
- `.afk/` local state ignored by git
- PR follow-up branch reuse, same-PR push, structured actionable review comment details, and verification reporting
- more consistent JSON envelopes for status and GitHub Actions remote commands
- production package build surface with compiled exports, declaration files, Node engine metadata, and a packable CLI tarball
- single-package `afk-geoff` CLI distribution with bundled internal packages, package smoke test, and custom command runner support

## P0

### 1. Harden verification and incremental recovery

Why:
- verification commands are an execution contract, not prose to pass directly to a shell
- a verifier defect should not cause a coding worker to modify an otherwise-correct repository
- retries should preserve reviewed commits and rerun only the affected verification or finalization stages

Scope:
- done: normalize and validate verification entries from project config, execution briefs, and run options before starting a worker
- done: reject alternatives such as npm versus pnpm with an actionable admission error; never execute natural-language connectives as shell syntax
- next: replace raw command arrays with structured verification entries where richer policies are needed
- done: select one package manager from `packageManager` metadata, existing lockfiles, and verification commands, and reject accidental secondary lockfiles
- done: classify verification outcomes as product, verification-contract, or environment failures
- done: route only product verification failures to a coding worker; block verification-contract and environment failures before review/fix
- next: propagate orchestrator and publishing failure categories through every terminal artifact
- done: fingerprint repeated product-verification and review failures and stop when the same failure recurs on an unchanged commit
- done: resume from existing reviewed commits and evidence when retrying a failed publishing/finalization stage
- next: add an explicit verification-only retry path for reviewed commits
- done: expose verification failure classification in `final-result.json` and its evidence packet
- done: expose reused evidence and retried publishing stages in `final-result.json`, inspect, and handoff evidence
- done: add regression coverage proving ambiguous commands are rejected without tracked state or a worker run
- done: add regression coverage for product, verification-contract, and environment verification routing
- done: add regression coverage for repeated verification and review failure loops
- done: add regression coverage proving a publishing retry does not repeat worker, verification, or review stages
- done: add regression coverage for lockfile-aware package-manager selection
- next: add regression coverage for verification-only retries

Success criteria:
- malformed verification is rejected before it consumes a worker iteration
- verifier/orchestrator failures cannot trigger unrelated code or lockfile changes
- a finalization retry can reuse a reviewed implementation without repeating the full worker/reviewer loop

### 2. Land PR comment resolution pass

Why:
- AFK-generated pull requests should support a second execution pass driven by human review comments
- this creates a practical reviewer loop instead of forcing the operator to manually translate comments back into a new brief

Scope:
- done: ingest actionable review comments from an open pull request
- done: run against the existing PR branch rather than creating a new branch
- done: push follow-up commits to the same PR
- done: report addressed review comment details in human output and `follow-up --json`
- done: report what project-level verification ran directly in `follow-up --json`
- next: document the follow-up JSON contract
- next: decide whether follow-up should inherit verification from the original execution brief

Notes:
- scope the first version to AFK-created pull requests
- do not auto-resolve comments in the first version

### 3. Machine-readable orchestration contract

Why:
- AFK should be easy for another agent framework or automation harness to call as a backend worker
- structured command output makes demos, CI integration, and bot workflows deterministic

Scope:
- done: harden the first `--json` output for core local run, watch, inspect, handoff, status, and follow-up commands
- done: include stable work item ids, run ids, PR URLs, branch names, terminal statuses, worktree paths, and failure reasons where those fields apply
- done: include `ok` and structured `error.message` fields for failing run, watch, inspect, handoff, follow-up, and remote GitHub Actions commands
- done: include backend identity in status and remote GitHub Actions command envelopes
- keep human-readable output as the default
- next: document the JSON contract and freeze representative examples
- next: cover doctor preflight edge cases with the same structured contract

### 4. Work admission and back pressure

Why:
- agents can produce more output than humans can review
- brownfield tasks with weak context or missing checks should not enter the same queue as well-scoped, cheaply verifiable work
- AFK should make orchestration tax visible before a run consumes time

Scope:
- classify incoming work before execution: `ready`, `needs_constraints`, `needs_tests`, `too_large`, or `blocked_by_environment`
- require or recommend verification commands for non-trivial code changes
- expand terse briefs into a visible, auditable acceptance rubric before execution
- provide project-aware rubric profiles; for CRUD web applications, cover every requested operation, runtime validation, client/API response contracts, automated tests, build, typecheck, lint, audit, and a clean committed handoff
- surface missing evidence as a queue/back-pressure reason instead of discovering it only after implementation
- time-box unactionable work and ask for a narrower brief when scope expands
- report queue health with counts by admission status and blocker reason

Notes:
- this is not a replacement for human judgment; it is a way to route attention to the right decisions earlier
- successful automation should reduce comprehension debt by producing smaller, better-evidenced changes

## Landed P0

### Evidence packet and outer-loop handoff

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

### 5. Explicit backend selection

Why:
- AFK should make it obvious whether a run is local or remote
- external orchestrators need predictable dispatch behavior

Scope:
- harden the first `--backend local-docker` selector on run and follow-up commands
- keep the configured default in `execution.backend`
- report the resolved backend in JSON command output
- leave unsupported remote backend names invalid until those backends exist

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
- distinguish agent sessions and workflow stages from underlying model inference calls
- record end-to-end and per-stage duration for brief expansion, work, review, fixes, verification, finalization, and retries
- report cached and uncached input, output, and reasoning tokens separately when available
- include the outer orchestration turn and brief-expansion overhead in end-to-end workflow totals
- attribute retry time and token cost to a structured retry cause
- document which runner metrics are operational estimates rather than directly comparable billing units

### 11. Comprehension debt tracking

Why:
- autonomous runs can widen the gap between code produced and code understood
- teams need lightweight signals that show when generated changes are becoming expensive to own

Scope:
- track change size, touched ownership areas, review iterations, and verification gaps as comprehension-risk signals
- include comprehension-risk notes in handoff artifacts for medium/high-risk runs
- prefer smaller follow-up briefs when a run crosses configurable size or complexity thresholds
