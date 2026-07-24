# AFK Geoff Orchestrator Contract

AFK Geoff is designed to be called by another orchestrator: an agent framework, scheduler, Slack bot, Linear bot, GitHub app, CI workflow, or another Codex/Claude session.

The orchestrator chooses the work and observes the result. AFK Geoff performs the isolated execution loop.

## Operating Model

Treat AFK as a backend worker, not as an interactive assistant.

The orchestrator should:

1. Check readiness with `afk doctor --json`.
2. Start a run with a structured command.
3. Capture the returned `runId`, `workItemId`, `branchName`, paths, and optional PR URL.
4. Observe progress through JSON/NDJSON.
5. Read `final-result.json` when the run completes.
6. Decide whether to publish, report, retry, or escalate.

The orchestrator should not scrape human-readable terminal prose.

## Local Detached Flow

Use this flow when a local agent CLI such as Codex or Claude is already authenticated on the host machine.

```bash
afk doctor --json
afk run file brief.md --detach --json
afk runs --json
afk watch <runId> --json
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

## Command Contracts

Stable orchestration commands should include `ok` on success or failure and structured error details on failure.

Primary commands:

- `afk doctor --json`
- `afk run file <path> --json`
- `afk run file <path> --detach --json`
- `afk run file <path> --pr --json`
- `afk runs --json`
- `afk watch <runId> --json`
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

If wrapper verification fails, AFK feeds the failure into the fix loop even when the reviewer returns `PASS`. If the loop cannot clear the issue, AFK should report a blocked or failed terminal state rather than a publishable success.

## Artifacts To Read

The orchestrator can use returned paths instead of guessing locations.

Important artifacts:

- `finalResultPath`: aggregate final run result and publishability decision
- `resultPath`: last worker result
- `runDir`: logs, prompts, review results, progress, and final result
- `worktreePath`: isolated checkout containing the produced branch
- `detachLogPaths`: stdout/stderr capture files for detached background workers

When present, prefer `finalResultPath` over `resultPath`; `resultPath` may describe only the last worker phase.

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

1. Read this document first.
2. Use JSON commands by default.
3. Run `doctor --json` before starting work.
4. Prefer `run file <brief.md> --detach --json` plus `watch --json` for orchestration demos.
5. Read `final-result.json` before declaring success.
6. Report branch, run id, final verdict, verification, publishability, and artifact paths.
