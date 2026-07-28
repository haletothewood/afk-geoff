# AFK Geoff Orchestrator Contract

AFK Geoff is designed to be called by another orchestrator: an agent framework, scheduler, Slack bot, Linear bot, GitHub app, CI workflow, or another Codex/Claude session.

The orchestrator chooses the work and observes the result. AFK Geoff performs the isolated execution loop.

For the shortest operational path, start with [Agent Orchestrator Quickstart](agent-orchestrator-quickstart.md).

## Operating Model

Treat AFK as a backend worker, not as an interactive assistant.

An orchestrator must invoke the AFK CLI. A Codex/Claude subagent or persona named "Geoff" is not an AFK worker unless it was started through `afk run ...`.

The orchestrator should:

1. Check readiness with `afk doctor --json`.
2. Start a run with a structured command.
3. Capture the returned `runId`, `workItemId`, `branchName`, paths, and optional PR URL.
4. Observe progress through JSON/NDJSON.
5. Inspect or hand off the run when it completes.
6. Decide whether to publish, report, retry, or escalate.

The orchestrator should not scrape human-readable terminal prose.

## Local Detached Flow

Use this flow when a local agent CLI such as Codex or Claude is already authenticated on the host machine.

```bash
afk doctor --json
afk run file brief.md --detach --json
afk runs --json
afk watch <runId> --json
afk inspect <runId> --json
afk handoff <runId> --json
```

`run --detach --json` returns quickly with the pre-created run identifiers. `watch --json` can then be used by a bot, scheduler, or parent agent to stream status until the run reaches a terminal state.

The detached kickoff payload includes `runDir`, `worktreePath`, and `detachLogPaths`. The log paths point at captured stdout/stderr from the background worker, so an orchestrator can surface useful diagnostics without attaching to the process.

## Local Foreground Flow

Use this flow when the caller wants one command to block until the AFK loop finishes.

```bash
afk doctor --json
afk run file brief.md --json
```

`run --json` is NDJSON. It emits lifecycle events while the worker runs and finishes with a final `kind: "run_result"` object.

## Pull Request Flow

Use `--pr` when AFK should publish a pull request as the handoff boundary.

```bash
afk doctor --json
afk run file brief.md --pr --json
afk follow-up <workItemId> --json
```

`follow-up` addresses actionable review comments on an AFK-created pull request and pushes commits to the same branch.

For detached orchestrators, combine the local detached flow with `--pr`:

```bash
afk doctor --json
afk run file brief.md --detach --pr --json
afk watch <runId> --json
afk inspect <runId> --json
afk handoff <runId> --json
```

After `watch` completes, use `handoff` for the bot-facing final summary or `inspect` for the richer diagnostic payload. The handoff summary includes the branch, review verdict, verification status, artifact paths, recommended action, and `pullRequest.url` when one was opened.

## Command Contracts

Stable orchestration commands should include `ok` on success or failure and structured error details on failure.

Primary commands:

- `afk doctor --json`
- `afk run file <path> --json`
- `afk run file <path> --detach --json`
- `afk run file <path> --pr --json`
- `afk runs --json`
- `afk watch <runId> --json`
- `afk inspect <runId> --json`
- `afk handoff <runId> --json`
- `afk status [workItemId] --json`
- `afk follow-up <workItemId> --json`
- `afk submit issue <github-issue-url> --backend github-actions --json`
- `afk remote-runs --json`
- `afk remote-artifacts <github-actions-run-id> --json`
- `afk remote-download <github-actions-artifact-id> --json`

## NDJSON Events

`run --json` and `watch --json` may emit multiple JSON objects, one per line.

Event lines use:

```json
{"kind":"run_event","event":"worker_started","runId":"run_...","workItemId":"wi_..."}
```

Terminal result lines use:

```json
{"kind":"run_result","command":"run","ok":true,"runId":"run_...","status":"completed"}
```

or:

```json
{"kind":"watch_result","command":"watch","ok":true,"runId":"run_...","status":"completed"}
```

On failure, commands emit an `ok: false` payload before exiting nonzero:

```json
{"kind":"watch_result","command":"watch","ok":false,"runId":"run_missing","error":{"message":"Run run_missing not found"}}
```

## Success Gate

For local execution, `final-result.json` is the authoritative completion artifact.

Treat a run as publishable only when:

- the final command result reports success
- `final-result.json` has `publishable: true`
- `whyNotPublishable` is empty
- wrapper verification passed
- the review gate passed
- there is a committed diff against the base branch
- the worktree is clean

Each failed wrapper-verification command records a `failureCategory`:

- `product`: a valid check found a product defect; AFK may feed it into the fix loop even when the reviewer returns `PASS`
- `verification`: the verification contract or shell command is malformed; AFK blocks without launching a fix worker
- `environment`: a required command, module, permission, or runtime dependency is unavailable; AFK blocks without launching a fix worker

Only product failures are actionable by a coding worker. Verification-contract and environment failures remain visible in `verificationSummaries`, `whyNotPublishable`, and the evidence packet, which recommends correcting the contract or environment before retrying.

AFK fingerprints product-verification failures and reviewer issue sets. If the same fingerprint recurs on the same Git commit after a fix attempt, AFK stops before consuming another worker iteration. The terminal `final-result.json` includes `repeatedFailure` with the failure kind, fingerprint, first and repeated iterations, and unchanged commit SHA.

If implementation, verification, and review completed successfully but PR publishing failed, rerunning the failed work item with `--pr` reuses those completed stages and retries publishing against the same branch and worktree. The run's `recovery` object, also included in the evidence packet returned by inspect and handoff, lists `reusedStages`, `retriedStages`, the source run, and recovery time.

## Artifacts To Read

The orchestrator can use returned paths instead of guessing locations.

Important artifacts:

- `finalResultPath`: aggregate final run result and publishability decision
- `resultPath`: last worker result
- `runDir`: logs, prompts, review results, progress, and final result
- `worktreePath`: isolated checkout containing the produced branch
- `detachLogPaths`: stdout/stderr capture files for detached background workers

When present, prefer `finalResultPath` over `resultPath`; `resultPath` may describe only the last worker phase.

`inspect <runId> --json` returns the run record, diagnostics, artifact paths, the parsed final result when available, an optional `pullRequest` external ref, and derived fields such as `publishable`, `reviewVerdict`, `verificationStatus`, `createdCommitCount`, and `worktreeClean`.

`handoff <runId> --json` returns a compact final summary for bots and parent agents. It includes `recommendedAction`, which is `publish` for a completed publishable run, `retry` for a failed run, `investigate` for an incomplete or still-running run, and `report_failure` for a completed non-publishable run.

`runs --json` and `status --json` include a `diagnostics` object for run records. Use it to detect common detached-worker states without guessing:

- `detachProcessPid` and `detachProcessAlive`
- `worktreeExists`
- `runDirExists`
- `resultExists`
- `finalResultExists`
- `lastProgressAgeSeconds`
- `detachLogPaths`

## Agent Instructions

When another agent session is asked to use AFK Geoff:

1. Read [Agent Orchestrator Quickstart](agent-orchestrator-quickstart.md), then this document when contract details matter.
2. Use JSON commands by default.
3. Run `doctor --json` before starting work.
4. Prefer `run file <brief.md> --detach --json` plus `watch --json` for orchestration demos.
5. Use `handoff <runId> --json` for the final report, or `inspect <runId> --json` for detailed diagnostics, before declaring success.
6. Report branch, run id, final verdict, verification, publishability, and artifact paths.
