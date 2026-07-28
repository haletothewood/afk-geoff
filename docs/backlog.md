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

Design constraints:
- AFK owns its domain model, interfaces, adapters, runtime lifecycle, and implementation.
- External agent-execution projects may inform design research, but AFK must not depend on, wrap, vendor, or copy their implementations.
- New lifecycle behaviour should deepen AFK's existing modules and seams before introducing another package or interface.
- Preserve AFK's branch, change-request, evidence, and publishability model rather than adopting another tool's completion or merge semantics.

## Product Outcome Coverage

AFK is positioned as the governed execution and evidence layer for agentic repository work. It is not the sole owner of an organisation's identity, CI/CD, security, observability, or management controls.

The current product assessment covers 39 CTO, team-member, and engineer concerns:

| Coverage | Count | Meaning |
|---|---:|---|
| Answered now | 12 | AFK has an implemented, testable mechanism that directly addresses the concern inside its execution-layer boundary |
| Partially answered | 18 | AFK provides useful primitives, but enforcement, measurement, integration, or organisational policy is incomplete |
| Not answered | 9 | AFK does not currently provide a substantive product mechanism |

Concern numbers below follow the order of the original 39-concern CTO and team brief. A concern may appear in more than one track when delivery requires both an AFK mechanism and an external integration.

| Roadmap area | Concerns materially addressed |
|---|---|
| Current execution, review, and handoff loop | 10–12, 16–20, 22, 26, 29, 33 |
| P0 reliability, lifecycle, and admission | 1, 9, 15, 20, 25, 34, 35 |
| P0 trust boundary and accountability | 6–8, 13, 14, 31, 39 |
| P1 evidence profiles and application verification | 17, 22–24, 29, 31, 32 |
| P1 economics and effectiveness telemetry | 1, 3–5, 26, 34, 35 |
| P1 operational response integrations | 6, 36, 37 |
| P2 source, publisher, and backend adapters | 21, 24, 32 |
| P2 human-approved organisational learning | 2, 15, 27, 28 |
| P2 proactive improvement and reuse discovery | 30, 38 |

Current strengths:
- human-in-the-loop decision routing and protection from unnecessary interruptions
- configurable worker and reviewer tools
- standardised briefs, runs, reviews, change-request handoffs, and follow-ups
- deterministic verification before bounded adversarial review
- truthful blocked and failed outcomes with structured reasons
- isolated branches and git worktrees for concurrent work
- evidence packets for human review
- reversible open-change-request and branch workflows

Roadmap gaps this backlog must close:
- secure, least-privilege execution and prompt-injection containment
- named accountability and stronger audit provenance
- spend, efficiency, and effectiveness measurement
- enforceable scope and evidence admission policies
- application-aware verification and visual evidence
- vulnerability and application-alert ingestion
- human-approved organisational learning from failures and feedback
- proactive improvement and reuse discovery

Cross-cutting success measures:
- first-pass acceptance rate and human review time
- lead time from admitted brief to publishable handoff
- verification, review, retry, and publishing failure rates by cause
- escaped defects and reversals attributable to AFK changes
- cost and duration per publishable contribution
- percentage of runs with complete required evidence
- percentage of runs using the required execution and approval policy

Priority meanings:
- `P0`: next features to build because they materially improve day-to-day usability or reliability
- `P1`: important follow-on features after the current rough edges are removed
- `P2`: valuable extension work once the core loop is stable

## Current Build Order

These are the next features to build in order.

### 1. Finish PR comment resolution pass

Why now:
- AFK-generated pull requests should support a second execution pass driven by human review comments
- this closes the loop from implementation run to reviewer-directed follow-up on the same PR
- the remaining gap is documenting the follow-up contract and deciding whether follow-up should inherit brief-local verification

### 2. Finish machine-readable orchestration contract

Why next:
- AFK's CLI should be usable as a stable backend API for another agent framework, bot, scheduler, or CI workflow
- external orchestrators need structured IDs, URLs, status, run artifacts, and failure reasons without scraping terminal prose
- the remaining gap is documenting and freezing the command contract once the envelopes are consistent

### 3. Harden run lifecycle and worktree ownership

Why next:
- detached and future concurrent runs need explicit ownership of worktrees and worker processes
- a run must terminate predictably when setup, the runner, verification, review, or publishing hangs
- cleanup and recovery behaviour should be observable through the same artifacts and JSON contract as normal completion

### 4. Work admission and back pressure

Why next:
- AFK should reject or narrow work before execution when scope, constraints, or verification are too weak
- queue throughput should be controlled by evidence quality, not just agent availability

### 5. Finish explicit backend selection

Why next:
- AFK should make it obvious whether a run is local or remote

### 6. Deepen the workspace runtime lifecycle

Why next:
- local process and local Docker execution should share one small, reliable runtime lifecycle
- implementation, verification, review, and fix phases should be able to reuse prepared infrastructure without leaking orchestration policy into runtime adapters
- a deeper workspace runtime seam is a prerequisite for safe additional isolation and remote execution adapters

### 7. Define runner capabilities and typed agent events

Why next:
- runner behaviour should depend on explicit, verified capabilities rather than runner-name conditionals
- agent stream events must remain distinct from authoritative worker results and workflow lifecycle events

### 8. Harden the optional GitHub Actions backend

Why later:
- once the command contract is stable, GitHub-backed repos can use CI for the cleanest unattended "work source in, PR out" path

### 9. Add isolated workspace transfer and recovery

Why later:
- future isolated-filesystem runtimes need a recovery-first way to transfer repository state without weakening AFK's evidence or branch model

### 10. Productionize package delivery

Why later:
- package smoke coverage exists, but repeatable CI, versioning, provenance, and release checks are required before AFK can be treated as dependable third-party infrastructure

## Outcome Track Sequencing

These outcome tracks extend, rather than replace, the current build order:

- `P0 — Trust boundary and accountability` starts after run ownership and admission have stable seams. Security policy must shape workspace-runtime and backend work before more powerful remote execution is added.
- `P1 — Evidence profiles and application-aware verification` builds on structured verification, admission, and artifact contracts.
- `P1 — Economics and effectiveness telemetry` builds on typed runner capabilities and the machine-readable orchestration contract.
- `P1 — Operational response integrations` builds on source adapters, security profiles, evidence profiles, and priority-aware admission.
- `P2 — Human-approved organisational learning` consumes stable evidence, review, reversal, and outcome data.
- `P2 — Proactive improvement and reuse discovery` remains read-only until a proposal passes normal admission and becomes an explicitly approved work item.

This sequence keeps the existing reliability work ahead of expansion while ensuring security, accountability, and measurable value are designed into the seams now.

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
- structured verification entries with backward-compatible string configuration and brief syntax
- tag-triggered npm trusted publishing with OIDC provenance, version/source guards, and package smoke gates
- structured orchestrator and publishing failures across terminal run records, completion artifacts, evidence, and CLI views

## P0

### 1. Harden verification and incremental recovery

Why:
- verification commands are an execution contract, not prose to pass directly to a shell
- a verifier defect should not cause a coding worker to modify an otherwise-correct repository
- retries should preserve reviewed commits and rerun only the affected verification or finalization stages

Scope:
- done: normalize and validate verification entries from project config, execution briefs, and run options before starting a worker
- done: reject alternatives such as npm versus pnpm with an actionable admission error; never execute natural-language connectives as shell syntax
- done: replace raw command arrays at the execution boundary with structured verification entries while preserving legacy string configuration and brief syntax
- done: select one package manager from `packageManager` metadata, existing lockfiles, and verification commands, and reject accidental secondary lockfiles
- done: classify verification outcomes as product, verification-contract, or environment failures
- done: route only product verification failures to a coding worker; block verification-contract and environment failures before review/fix
- done: propagate orchestrator and publishing failure categories through every terminal artifact
- done: fingerprint repeated product-verification and review failures and stop when the same failure recurs on an unchanged commit
- done: resume from existing reviewed commits and evidence when retrying a failed publishing/finalization stage
- done: add an explicit verification-only retry path for reviewed, unchanged commits
- done: expose verification failure classification in `final-result.json` and its evidence packet
- done: expose reused evidence and retried verification or publishing stages in `final-result.json`, inspect, and handoff evidence
- done: add regression coverage proving ambiguous commands are rejected without tracked state or a worker run
- done: add regression coverage for product, verification-contract, and environment verification routing
- done: add regression coverage for repeated verification and review failure loops
- done: add regression coverage proving a publishing retry does not repeat worker, verification, or review stages
- done: add regression coverage for lockfile-aware package-manager selection
- done: add regression coverage for verification-only retries and invalidated review evidence

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
- next: replace the open-ended run event field bag with a versioned discriminated event schema and freeze representative NDJSON sequences
- next: document workflow lifecycle events separately from future agent stream events
- next: state explicitly that `result.json` is the authoritative worker outcome while `final-result.json` is the authoritative completion and publishability artifact
- next: cover doctor preflight edge cases with the same structured contract

### 4. Harden run lifecycle and worktree ownership

Why:
- detached runs can outlive their parent command and future dispatch may start multiple work runs concurrently
- worktree reuse without explicit ownership can let two runs mutate the same branch or checkout
- the current total-run and heartbeat expiry checks are supervisory safeguards, not active cancellation or stage-specific deadlines

Scope:
- add an AFK-native worktree lease owned by a run, stored outside the worktree, and acquired atomically before mutation begins
- record enough lease metadata for diagnosis and recovery, including run id, process id, branch name, worktree path, and acquisition time
- fail fast when a live run owns the worktree; detect and safely prune stale leases without deleting preserved work
- release leases on success, failure, cancellation, and orderly shutdown, independently of whether the worktree is retained
- propagate cancellation from the CLI through the execution backend and workspace runtime to the active worker process or container
- define graceful termination followed by bounded forced termination for local process and local Docker execution
- standardize the meanings of execution phase and lifecycle stage before adding active deadlines
- add explicit workspace-preparation, worker-idle, completion-drain, verification, review, finalization, and publishing deadlines while retaining total-run and heartbeat expiry
- decide whether cancellation is a distinct run status or a structured failure reason before changing persisted state
- classify lifecycle deadline, cancellation, and cleanup outcomes so they appear consistently in run events, progress, `final-result.json`, inspect, and handoff
- centralize process shutdown handling so multiple active runs do not each install competing signal handlers
- extend `doctor`, `status`, `inspect`, and `cleanup` diagnostics with lease ownership, stale-lease, and termination evidence
- add regression coverage for concurrent lease acquisition, stale owners, cancellation during every active phase, completion-with-open-output, forced termination, and preserved-worktree recovery
- record the lease, cancellation, and deadline semantics in ADRs before broadening concurrency

Success criteria:
- two runs cannot concurrently mutate the same worktree or branch
- every active local worker can be cancelled and is bounded by an active, stage-appropriate deadline
- interrupted runs leave an authoritative terminal artifact or enough structured diagnostics for deterministic recovery
- cleanup never destroys a live or intentionally preserved worktree

### 5. Work admission and back pressure

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

### Trust boundary and accountability

Why:
- Docker isolation and environment allowlisting are useful primitives, but they are not yet a hardened least-privilege sandbox
- local-process runners deliberately inherit more host trust and must not be presented as equivalent to isolated execution
- repository issues, comments, source files, tool output, and alert payloads may all contain untrusted instructions
- a human should remain visibly accountable for every proposed contribution and protected action

Scope:
- define execution security profiles such as `local-trusted`, `container-restricted`, and `remote-restricted`
- expose the resolved security profile, runner, model, credential grants, network policy, and writable paths in run artifacts and JSON output
- harden restricted containers with dropped capabilities, `no-new-privileges`, explicit writable mounts, resource limits, and deny-by-default network policy where supported
- replace broad ambient credentials with task-scoped, short-lived credentials where providers support them
- add action-level permissions so reading source, pushing a branch, opening a change request, changing infrastructure, and deploying are separately authorised
- distinguish trusted operator instructions from untrusted repository, issue, comment, alert, and tool content
- add prompt-injection test fixtures and policies that prevent untrusted content from expanding permissions or changing the execution contract
- require a named accountable owner and approval policy for publishable runs
- record the initiating actor, accountable owner, runner identity, reviewed commit, approvals, and protected actions in the evidence packet
- provide an append-only audit export suitable for organisational logging and compliance systems
- ensure incident urgency can shorten queueing without weakening verification, permission, or approval gates

Success criteria:
- a restricted run cannot access undeclared credentials, writable host paths, network destinations, or protected actions
- untrusted input cannot grant itself tools, credentials, network access, or publication authority
- every publishable handoff identifies the initiating actor, accountable human, reviewed commit, effective policy, and verification evidence
- local trusted execution is clearly labelled and cannot be mistaken for restricted execution

Ownership boundary:
- AFK enforces and reports its execution policy
- identity providers, repository protection, cloud IAM, secret brokers, and SOC2 control ownership remain external integrations

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

### 6. Finish explicit backend selection

Why:
- AFK should make it obvious whether a run is local or remote
- external orchestrators need predictable dispatch behavior

Scope:
- done: support explicit `--backend local-docker` and `--backend local-process` selection on run and follow-up commands
- done: keep the configured default in `execution.backend`
- done: report the resolved backend in JSON command output
- done: reject unsupported backend names until adapters exist
- next: document and freeze the distinction between an execution backend, a workspace runtime, and a remote workflow harness
- next: expose backend readiness and supported lifecycle capabilities through `doctor --json`

### 7. Deepen the workspace runtime lifecycle

Why:
- the execution backend currently owns both AFK's work/review/verification policy and low-level workspace lifecycle details
- local process and local Docker are already two adapters at the workspace runtime seam, so the seam should earn its keep by hiding setup, execution, cancellation, and cleanup consistently
- future isolated or remote execution should not require duplicating the evidence and publishability loop

Scope:
- keep the implementation AFK-native with no dependency on, adapter for, vendoring of, or copied implementation from another agent-execution project
- deepen the existing workspace runtime module around a small lifecycle: prepare a workspace, execute commands with streaming and cancellation, and close or preserve it with a structured result
- keep worktree creation, branch ownership, verification policy, autonomous review, evidence, and publishing in AFK's execution backend rather than moving them into runtime adapters
- make isolation characteristics explicit for host-process, bind-mounted Docker, and future isolated runtimes without exposing provider-specific options to every caller
- let one prepared local Docker workspace be reused only within the same work run across implementation, verification, review, and fix phases when repository state and credential isolation remain safe
- guarantee phase locality: each command has explicit working directory, environment allowlist, input, output paths, active deadline, and termination behaviour
- keep AFK's named branch and change-request handoff model; do not add direct-to-head or implicit merge strategies
- test runtime behaviour through the workspace runtime interface with shared contract tests for local process and local Docker adapters
- record workspace ownership and reuse decisions in ADRs before adding another runtime adapter

Success criteria:
- the execution backend expresses AFK policy without containing process/container lifecycle mechanics
- local process and local Docker satisfy the same observable runtime contract
- reusing a prepared workspace cannot leak state across work items or weaken verification evidence
- adding an isolated runtime does not duplicate the work, review, evidence, or publication loop

### 8. Runner capabilities and typed agent stream

Why:
- runner behaviour is currently selected partly by runner kind and command conventions
- usage accounting, session continuity, structured output, and tool-call observability are not reliable across every runner
- external orchestrators need stable events without treating raw stdout as the worker result

Scope:
- add explicit runner capability metadata only for behaviour AFK can verify, such as streaming, structured result production, session continuity, tool-call events, and usage reporting
- keep `result.json` as the authoritative worker result; completion markers and terminal prose must remain diagnostic signals only
- distinguish workflow lifecycle events from typed agent stream events such as text, tool call, raw diagnostic line, and usage update
- version event payloads before external consumers depend on them and preserve the current compact NDJSON lifecycle stream
- expose session resume or fork behaviour only for runners with a reliable native mechanism, and keep it distinct from AFK's PR follow-up run
- tolerate unavailable capabilities without runner-kind conditionals spreading through the execution backend
- add capability-contract tests for built-in Claude, Codex, custom, and smoke runner configurations

Success criteria:
- callers can determine supported runner behaviour without inferring it from a runner name
- raw agent output cannot be mistaken for an authoritative run result
- adding a runner does not require edits throughout the execution backend

### 9. Harden the optional GitHub Actions backend

Why:
- for GitHub-backed repos, the cleanest unattended path is often “issue in, PR out” from CI instead of the local machine

Scope:
- harden the first manual `workflow_dispatch` harness for "issue URL in, PR out"
- done: expose an init flag for installing the GitHub Actions harness in target repos
- done: make the GitHub Actions harness check out AFK Geoff instead of requiring target repos to install the CLI
- done: expose a CLI workflow dispatch command for external orchestrators
- done: publish machine-readable workflow artifacts for preflight and run results
- done: expose CLI commands for listing recent remote workflow runs and their artifacts
- done: expose a CLI command for downloading remote workflow artifacts
- next: define how local SQLite state and remote workflow state reconcile without making GitHub authoritative
- next: add a remote execution backend behind the existing execution backend port only after the JSON and reconciliation contracts are frozen
- next: add concurrency controls keyed by work item or change request so duplicate workflow dispatches cannot race
- next: harden workflow permissions, credential exposure, artifact retention, cancellation, and retry semantics
- keep local Docker execution as the portable default

### 10. Isolated workspace transfer and recovery

Why:
- a future isolated-filesystem runtime cannot rely on the host worktree being mounted directly
- repository changes must survive transfer or application failure before AFK can trust remote or VM-backed execution
- this transport is distinct from AFK `sync`, which reconciles mirrored remote state into SQLite

Scope:
- design and implement the transfer protocol independently within AFK, without copying or adapting another agent-execution implementation
- scope the protocol to isolated-filesystem runtime adapters; keep bind-mounted local Docker as the portable default
- transfer the input repository state from an explicit ref and verify the isolated workspace starts from the expected commit
- persist a recovery bundle containing committed changes, uncommitted changes, and untracked files as run artifacts before applying anything to the host worktree
- apply the preserved changes atomically where possible and leave the source artifacts untouched until application and repository verification succeed
- mark the run non-publishable when transfer or application fails and include exact recovery paths and commands in inspect and handoff
- ensure transfer never bypasses the worktree lease, named branch, clean-worktree, verification, review, or publishability rules
- add failure-injection tests for interrupted input transfer, partial output collection, conflicting host changes, failed application, duplicate application, and recovery replay
- record the transfer, recovery-bundle, and application semantics in an ADR before implementing an isolated runtime adapter

Dependencies:
- hardened run lifecycle and worktree ownership
- deepened workspace runtime lifecycle
- frozen evidence and failure taxonomy

Success criteria:
- an isolated runtime failure cannot destroy the only copy of produced changes
- recovery is deterministic from returned run artifact paths
- isolated execution preserves the same authoritative result, evidence, branch, and publishability rules as local Docker

### 11. Productionize package delivery

Why:
- AFK has a packable CLI, declaration output, and package smoke test, but release correctness still depends on a maintainer running the right local commands
- consumers need repeatable compatibility, provenance, and upgrade signals

Scope:
- next: add pull-request and main-branch CI for build, typecheck, unit tests, package smoke, and the developer workflow smoke
- test the supported Node version range and isolate Docker-required checks from credential-free package checks
- done: publish matching version tags through npm trusted publishing with OIDC provenance after typecheck, unit tests, build, and package smoke gates
- next: add automated versioning, changelog generation, release approval, and a documented rollback/deprecation procedure
- verify that public imports and declaration files do not execute initialization side effects or reference unpublished workspace packages
- freeze representative CLI help, config migration, JSON envelope, and artifact-schema compatibility tests
- publish a support policy covering Node versions, runner profiles, experimental backends, and breaking command-contract changes
- keep release automation independent of any agent-execution framework

Success criteria:
- every published package is produced from a green, reproducible CI run
- consumers can identify supported environments and breaking changes before upgrading
- package contents, executable entry points, declarations, and machine-readable contracts are verified before publication

### Evidence profiles and application-aware verification

Why:
- command output alone is not sufficient evidence for every kind of contribution
- reviewers should receive the smallest complete evidence set needed to understand behavior without repeating manual smoke tests
- application and infrastructure changes may require proof across multiple affected environments

Scope:
- add project-defined evidence profiles for library, API, web UI, integration, infrastructure, migration, and incident work
- let admission select or require a profile based on affected areas and work type
- require deterministic test, build, typecheck, lint, audit, plan, or smoke commands appropriate to the selected profile
- define an application matrix so a brief can declare every application or integration that must be verified
- support artifact-producing verification steps for screenshots, before/after captures, short demo recordings, accessibility reports, infrastructure plans, and API examples
- retain artifacts with provenance linking them to the command, commit, application, environment, and run
- include artifact summaries and direct paths or URLs in inspect, handoff, and change-request output
- distinguish required evidence from optional manual QA guidance
- block publishability when required applications or artifacts have not been verified

Success criteria:
- every publishable run satisfies its selected evidence profile
- reviewers can see which applications and environments were exercised and which were not
- required screenshots, demonstrations, plans, and reproduction evidence are tied to the reviewed commit
- generated or transient evidence artifacts cannot pollute the product diff

### Economics and effectiveness telemetry

Why:
- spend visibility is necessary for budgeting, but cost alone does not show whether agents are effective
- operators need explicit dials for cost, latency, autonomy, and review power
- AFK should measure the complete workflow rather than only the inference calls a runner happens to expose

Scope:
- build on the runner capability contract rather than inferring metric support from runner kind
- capture token usage only when the configured runner exposes it reliably
- distinguish agent sessions and workflow stages from underlying model inference calls
- report cached and uncached input, output, and reasoning tokens separately when available
- record end-to-end and per-stage duration for admission, brief expansion, work, review, fixes, verification, finalization, and retries
- include outer-orchestrator and brief-expansion overhead in end-to-end totals when supplied by the caller
- attribute retry time and token cost to a structured retry cause
- accept provider pricing metadata or externally supplied billed cost without presenting estimates as invoices
- add per-run and per-project limits for cost, duration, iterations, model class, and concurrency
- define stop, downgrade, narrow, and escalate behavior when a limit is approached
- report first-pass acceptance, review iterations, human review time, reversals, and escaped-defect signals when integrations provide them
- provide aggregate JSON suitable for dashboards and budgeting systems
- document which metrics are estimates and which are directly comparable billing units

Success criteria:
- an operator can explain the cost and elapsed time of a complete AFK contribution
- budget limits produce a structured stop, narrowing, downgrade, or escalation decision
- cost can be compared with outcome measures rather than treated as a standalone success metric
- missing runner usage data is reported explicitly instead of silently treated as zero

### Operational response integrations

Why:
- incident and security execution modes are only useful at scale when operational signals can become constrained, evidence-rich work
- alert context and proposed fixes should reduce time to resolution without granting production authority to an agent

Scope:
- add source adapters for vulnerability scanners and application-alert systems
- normalize alert identity, severity, affected service, ownership, timestamps, links, and available telemetry
- correlate alerts with relevant code, recent changes, runbooks, ownership data, and previous incidents
- produce a context packet before proposing code changes
- generate a constrained incident or vulnerability brief with explicit reproduction and verification requirements
- allow AFK to propose and verify a fix in an isolated branch and change request
- enforce severity-aware queue priority and response-time reporting without bypassing security or human approval policies
- deduplicate recurring alerts and stop repeated unchanged fix attempts
- post structured progress and final evidence back to the originating alert or incident system
- keep production mutation and deployment outside the default AFK authority

Success criteria:
- an alert can be traced from source event through context, proposed fix, verification, review, and human verdict
- critical vulnerabilities receive prioritised admission and measurable response timing
- proposed fixes include reproduction or detection evidence and proof that the signal cleared
- AFK cannot deploy or mutate production unless a separately configured external policy explicitly authorises that action

## P2

### 12. More source adapters

Candidates:
- GitLab issue source
- Azure DevOps work item source
- Bitbucket source
- Linear issue source
- Slack command source
- GitHub App webhook source

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

### 15. Comprehension debt tracking

Why:
- autonomous runs can widen the gap between code produced and code understood
- teams need lightweight signals that show when generated changes are becoming expensive to own

Scope:
- track change size, touched ownership areas, review iterations, and verification gaps as comprehension-risk signals
- include comprehension-risk notes in handoff artifacts for medium/high-risk runs
- prefer smaller follow-up briefs when a run crosses configurable size or complexity thresholds

Success criteria:
- medium- and high-risk handoffs explain why a change may be expensive to understand or own
- configured size or ownership thresholds cause work to be narrowed before review
- teams can compare generated throughput with the review and comprehension burden it creates

### 16. Human-approved organisational learning

Why:
- recurring mistakes and review feedback should improve future work across the team
- automatically changing business rules from agent output would create an unsafe, self-modifying policy loop

Scope:
- fingerprint recurring verification failures, review findings, reversals, follow-up comments, and escaped defects across runs
- group candidate lessons by repository, ownership area, execution mode, and evidence profile
- propose changes to documented standards, prompt overrides, verification profiles, skills, templates, or architecture rules
- show the source evidence and affected future workflows for every proposed rule
- publish learning proposals as normal reviewable contributions
- require a named human owner and approval before a proposed lesson becomes an active rule
- version active policies and record which version governed each run
- measure whether an accepted rule reduces recurrence without increasing false blocks or orchestration tax

Success criteria:
- repeated mistakes and feedback produce reviewable policy proposals rather than silently changing agent behavior
- every active rule is traceable to evidence, an approving human, and a versioned repository change
- ineffective rules can be identified, reverted, or narrowed

### 17. Proactive improvement and reuse discovery

Why:
- AFK currently executes submitted work; it does not discover worthwhile improvements on its own
- proactive proposals should compete for human attention based on evidence and expected value, not merely agent enthusiasm

Scope:
- support scheduled, read-only discovery runs for process, code, architecture, business-rule, and duplication risks
- detect repeated code shapes and propose appropriately scoped reusable abstractions
- identify recurring manual workflow, verification, and review costs as process-improvement candidates
- require evidence of repetition, ownership, expected benefit, migration scope, and verification strategy
- rank proposals by expected value, risk, confidence, and comprehension cost
- submit proposals to admission rather than automatically modifying repositories
- deduplicate proposals and suppress repeatedly rejected or low-value findings

Success criteria:
- proactive runs cannot mutate product repositories or production systems
- every proposal includes concrete evidence and a reviewable execution brief
- accepted proposals remain small enough for the normal AFK verification and review loop
- proposal quality can be measured by acceptance, completion, and realised-benefit signals

## Product Boundaries

AFK can be the primary execution and evidence mechanism for most of the 39 concerns, but it must not claim sole ownership of outcomes enforced elsewhere.

AFK owns:
- admission, isolation, execution policy, verification, autonomous review, evidence, structured handoff, retry, and reversible pre-merge changes
- recording the effective runner, model, backend, policy, credentials granted, artifacts, and run outcomes
- blocking or escalating when its evidence or authority is insufficient

External systems and accountable humans own:
- identity proofing, employment accountability, repository protection, and final merge authority
- cloud IAM, secret issuance, production access, deployment approval, and rollback execution
- CI service reliability, observability data quality, vulnerability scanner coverage, and SOC2 control design
- deciding whether business outcomes justify continued agent investment

AFK should integrate with those systems and surface their decisions in its evidence packet. It should not imply that an agent prompt or successful run replaces them.
