# Local Execution JSON Contract

This document freezes the public command-result envelopes for local execution. It covers `doctor --json` and the final `run_result` line from foreground and detached `run --json` commands.

Human-readable output remains the default. Callers that need a stable interface must pass `--json`, read stdout as JSON or NDJSON as described below, and never parse terminal prose.

Versioned streaming lifecycle event schemas are defined separately in the
[Lifecycle Event Contract](lifecycle-event-contract.md). `run --json` emits zero or
more validated `run_event` lines before its terminal `run_result` line. This document
freezes the command-result envelope.

## Shared Rules

JSON objects use these presence and nullability rules:

| Field | Presence | Nullability and meaning |
| --- | --- | --- |
| `command` | Always | Non-null command name: `doctor` or `run`. |
| `ok` | Always | Non-null boolean. `true` means the command achieved the result represented by this envelope. |
| `backend` | Always | Non-null backend identity after configuration and repository context load. It is `null` only when context could not be loaded, so no backend could be resolved. |
| `error` | Failure only | Non-null object with a non-null `message`. `category` is present only for classified terminal failures. |
| `workItemId`, `requirementId`, `runId` | Run outcome only | Non-null when present. They are absent when failure occurs before the corresponding entity is available. They are never placeholder strings and never `null`. |
| `status` | Tracked run outcome only | Non-null when present. It is absent for admission and preflight failures that return no tracked outcome. |
| `branchName`, `worktreePath`, `runDir` | Tracked run outcome only | Non-null when present. They are absent if the command fails before it can return a tracked outcome. |
| `resultPath`, `finalResultPath` | Completed foreground outcome only | Non-null when present. Detached kickoff does not claim that these artifacts exist yet. |
| `terminalFailure` | Classified terminal failure only | Non-null `{ "category", "message" }`. When present, `error.category` is the same category. |

Optional fields are omitted rather than set to `null`, except for `backend` when context loading fails. Consumers must distinguish an absent field from an explicit `backend: null`.

Paths are native paths for the host running AFK and may be absolute. Callers should consume returned path fields rather than construct `.afk` paths themselves.

## `doctor --json`

`doctor --json` writes exactly one JSON object. A failed check or context failure exits nonzero after writing the object.

The envelope always has:

- `command`, equal to `doctor`
- `ok`
- `backend`
- `checks`, an array
- `failures`, an array of the failed check messages

Successful checks have exactly `label`, `ok: true`, and `detail`. Failed checks have exactly `label`, `ok: false`, and `error`. A failed envelope also has top-level `error.message`.

### Preflight matrix

| Condition | Backend | Check or envelope behavior |
| --- | --- | --- |
| Current directory is not a Git repository | `null` | Context failure; `checks` is empty and `failures[0]` equals `error.message`. |
| `.afk/config.yaml` is missing, malformed, or invalid | `null` | Context failure; `checks` is empty and `failures[0]` equals `error.message`. |
| `git` executable is missing after context load | Resolved backend | Failed `git` check. |
| Configured runner executable is missing | Resolved backend | Failed `runner` check. |
| A configured `runner.requiredEnv` variable is missing | Resolved backend | Failed `env:<NAME>` check. |
| Backend is `local-docker` and Docker is missing | `local-docker` | Failed `docker` check. |
| Backend is `local-process` | `local-process` | No Docker check is emitted. |
| GitHub integration is enabled and repository coordinates cannot be resolved | Resolved backend | Failed `github` repository-precondition check. |
| GitHub integration is enabled and `gh` is missing | Resolved backend | Failed `gh` check. |
| All applicable checks pass | Resolved backend | `ok: true`, `failures: []`, and no top-level `error`. |

Doctor reports all check failures it can evaluate; it does not stop after the first missing executable or environment variable.

### Successful preflight

```json
{
  "command": "doctor",
  "backend": "local-docker",
  "ok": true,
  "checks": [
    { "label": "git", "ok": true, "detail": "git" },
    { "label": "docker", "ok": true, "detail": "docker" },
    { "label": "runner", "ok": true, "detail": "node" }
  ],
  "failures": []
}
```

### Missing executables and required environment

```json
{
  "command": "doctor",
  "backend": "local-docker",
  "ok": false,
  "checks": [
    { "label": "git", "ok": true, "detail": "git" },
    { "label": "docker", "ok": false, "error": "Missing docker executable: docker" },
    { "label": "runner", "ok": false, "error": "Missing runner executable: codex" },
    { "label": "env:OPENAI_API_KEY", "ok": false, "error": "Missing required env var OPENAI_API_KEY" }
  ],
  "failures": [
    "Missing docker executable: docker",
    "Missing runner executable: codex",
    "Missing required env var OPENAI_API_KEY"
  ],
  "error": { "message": "Doctor checks failed (3 issues)" }
}
```

### Invalid configuration

```json
{
  "command": "doctor",
  "ok": false,
  "backend": null,
  "checks": [],
  "failures": ["Invalid input: expected 1"],
  "error": { "message": "Invalid input: expected 1" }
}
```

### Repository precondition failure

```json
{
  "command": "doctor",
  "backend": "local-process",
  "ok": false,
  "checks": [
    { "label": "git", "ok": true, "detail": "git" },
    { "label": "runner", "ok": true, "detail": "codex" },
    { "label": "gh", "ok": true, "detail": "gh" },
    {
      "label": "github",
      "ok": false,
      "error": "GitHub is enabled but origin remote owner/repo could not be resolved."
    }
  ],
  "failures": ["GitHub is enabled but origin remote owner/repo could not be resolved."],
  "error": { "message": "Doctor checks failed (1 issue)" }
}
```

When `gh` is missing, the check in that same position is `{ "label": "gh", "ok": false, "error": "Missing gh executable: gh" }`. The repository-coordinate check is still emitted after it, so both errors appear in `failures` and the top-level message reports two issues.

## `run --json`

`run --json` writes NDJSON. The last non-empty stdout line is exactly one `kind: "run_result"` command-result envelope. Read and parse that line for the command result; do not infer success from earlier lifecycle events or terminal prose.

Fields common to every `run_result` are:

- `kind`, equal to `run_result`
- `command`, equal to `run`
- `ok`
- `target`
- optional `value`, present for `file` and `issue` targets
- `backend`
- `requirePullRequest`
- `detached`

### Mode-specific presence

| Field | Foreground success | Detached kickoff success | Admission/preflight failure | Terminal execution failure |
| --- | --- | --- | --- | --- |
| `workItemId`, `runId` | Present | Present | Absent | Absent from the result envelope; use prior events or inspection if a run was created |
| `requirementId` | Present for `file` and `issue` targets; absent for direct work-item targets | Present for `file` and `issue` targets; absent for direct work-item targets | Absent | Absent from the result envelope |
| `status` | Present and terminal | Present as `running` | Absent | Absent |
| `branchName`, `worktreePath`, `runDir` | Present for a tracked local run | Present | Absent | Absent |
| `resultPath`, `finalResultPath` | Present for a tracked completed run | Absent because artifacts are not complete | Absent | Absent |
| `finalVerdict` | Present when `final-result.json` supplied one | Absent | Absent | Absent |
| `detachLogPaths` | Absent | Present | Absent | Absent |
| `prUrl` | Present only when publishing opened or updated a PR | Absent at kickoff | Absent | Absent |
| `error` | Absent | Absent | Present | Present |
| `terminalFailure` | Absent | Absent | Absent | Present only for classified orchestration or publishing failures |

A successful command envelope does not imply publishability. Read `finalResultPath` and require `publishable: true`.

### Foreground success

```json
{
  "kind": "run_result",
  "command": "run",
  "ok": true,
  "target": "file",
  "value": "brief.md",
  "backend": "local-docker",
  "requirePullRequest": false,
  "detached": false,
  "workItemId": "wi_...",
  "requirementId": "req_...",
  "runId": "run_...",
  "status": "completed",
  "branchName": "afk/wi_...-implement-contract",
  "worktreePath": "/repo/.afk/worktrees/run_...",
  "runDir": "/repo/.afk/runs/run_...",
  "resultPath": "/repo/.afk/runs/run_.../result.json",
  "finalResultPath": "/repo/.afk/runs/run_.../final-result.json",
  "finalVerdict": "done"
}
```

### Foreground preflight failure

```json
{
  "kind": "run_result",
  "command": "run",
  "ok": false,
  "target": "file",
  "value": "brief.md",
  "backend": "local-docker",
  "requirePullRequest": false,
  "detached": false,
  "error": {
    "message": "Preflight failed (runner): runner executable not found: codex"
  }
}
```

If repository or configuration context cannot load, this envelope has `backend: null` unless an explicit valid `--backend` was supplied.

### Detached kickoff success

```json
{
  "kind": "run_result",
  "command": "run",
  "ok": true,
  "target": "file",
  "value": "brief.md",
  "backend": "local-docker",
  "requirePullRequest": false,
  "detached": true,
  "workItemId": "wi_...",
  "requirementId": "req_...",
  "runId": "run_...",
  "status": "running",
  "branchName": "afk/wi_...-implement-contract",
  "worktreePath": "/repo/.afk/worktrees/run_...",
  "runDir": "/repo/.afk/runs/run_...",
  "detachLogPaths": {
    "stdout": "/repo/.afk/runs/run_.../detach-stdout.log",
    "stderr": "/repo/.afk/runs/run_.../detach-stderr.log"
  }
}
```

### Detached launch failure

```json
{
  "kind": "run_result",
  "command": "run",
  "ok": false,
  "target": "file",
  "value": "brief.md",
  "backend": "local-docker",
  "requirePullRequest": false,
  "detached": true,
  "error": {
    "message": "Detached launch failed: spawn failed"
  }
}
```

### Classified terminal failure

```json
{
  "kind": "run_result",
  "command": "run",
  "ok": false,
  "target": "file",
  "value": "brief.md",
  "backend": "local-docker",
  "requirePullRequest": true,
  "detached": false,
  "terminalFailure": {
    "category": "publishing",
    "message": "Post-run publication failed: GitHub rejected the pull request"
  },
  "error": {
    "category": "publishing",
    "message": "GitHub rejected the pull request"
  }
}
```

## Artifact Authority

`result.json` is the authoritative worker outcome. It contains the worker's status, summary, issue comment, and optional PR proposal for the latest worker phase.

`final-result.json` is the authoritative completed-run and publishability artifact. It aggregates worker, verification, review, repository-state, and terminal-failure evidence. A caller deciding whether a run completed successfully or may be published must use `final-result.json`, not `result.json`, lifecycle events, exit prose, or completion markers.

The foreground `run_result.finalResultPath` and the later `inspect --json` and `handoff --json` path fields identify this artifact only after it exists. A command omits an artifact path if persistence did not produce that file. Detached callers should wait for a terminal run state and then obtain the path through `inspect` or `handoff`.

The observation, handoff, pull-request publication, and review follow-up envelopes are frozen separately in [Local Observation and Publishing JSON Contract](local-observation-publishing-json-contract.md).
