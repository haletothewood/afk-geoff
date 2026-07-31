# Local Observation and Publishing JSON Contract

This document freezes the command-result envelopes used to observe local AFK runs, hand completed work to another orchestrator, publish a pull request, and process reviewer-directed follow-up. It builds on the presence, nullability, artifact-authority, and structured-error rules in [Local Execution JSON Contract](local-execution-json-contract.md).

Human-readable output remains the default. Stable callers pass `--json` and parse JSON or NDJSON. Versioned lifecycle-event schemas remain out of scope: for `watch --json`, only the terminal `watch_result` line is frozen.

## Shared Rules

Every result has non-null `command` and `ok`. `backend` is non-null after context load and `null` when context did not load. Failures have a non-null `error.message`. Optional fields are omitted rather than set to `null`.

Identifiers and paths are never placeholders. `resultPath` and `finalResultPath` are present only after the corresponding file exists. Callers must not construct artifact paths from `runDir`.

`result.json` is the authoritative latest worker outcome. `final-result.json` is the authoritative terminal state and publishability decision. If artifact persistence fails, the command emits a structured failure and omits the unavailable path.

`terminalFailure`, when present, is `{ "category": "orchestrator" | "publishing", "message": string }`; `error.category` repeats the category. Expected lookup/admission failures have an unclassified `error.message`.

## Observation

### `runs --json`

Success has `count` and `runs`. Every run is a stored run record augmented with `diagnostics`.

```json
{
  "command": "runs",
  "ok": true,
  "backend": "local-process",
  "count": 1,
  "runs": [{
    "id": "run_...",
    "workItemId": "wi_...",
    "mode": "work",
    "status": "completed",
    "branchName": "afk/wi_...-freeze-contract",
    "worktreePath": "/repo/.afk/worktrees/run_...",
    "runDir": "/repo/.afk/runs/run_...",
    "diagnostics": {
      "worktreeExists": true,
      "runDirExists": true,
      "resultExists": true,
      "finalResultExists": true
    }
  }]
}
```

Diagnostics always contain `runDirExists`, `resultExists`, and `finalResultExists`. `worktreeExists` is present when a worktree was recorded. Detached process, progress-age, and log fields are present only when discovered.

Context or synchronization failure:

```json
{
  "command": "runs",
  "ok": false,
  "backend": null,
  "error": { "message": "Invalid input: expected 1" }
}
```

### `status [workItemId] --json`

Success has `requirements`, `workItems`, `runnable`, `blocked`, `hitl`, `active`, `terminalFailures`, and `nextActions`. A requested `workItemId` is repeated. `focusedWorkItem` is present only when it exists. Active runs contain diagnostics and contain `progress` only when `progress.json` is readable.

```json
{
  "command": "status",
  "ok": true,
  "backend": "local-process",
  "workItemId": "wi_...",
  "requirements": [],
  "workItems": [{ "id": "wi_...", "status": "done" }],
  "runnable": [],
  "blocked": [],
  "hitl": [],
  "active": [],
  "terminalFailures": [],
  "nextActions": ["- All work items are complete"],
  "focusedWorkItem": { "id": "wi_...", "status": "done" }
}
```

Context or synchronization failure uses the shared failure envelope and retains a requested `workItemId`.

### `watch <runId> --json`

This is NDJSON: zero or more unstable `run_event` lines precede exactly one frozen `watch_result`.

```json
{
  "kind": "watch_result",
  "command": "watch",
  "ok": true,
  "backend": "local-process",
  "runId": "run_...",
  "workItemId": "wi_...",
  "status": "completed",
  "mode": "work",
  "branchName": "afk/wi_...-freeze-contract",
  "worktreePath": "/repo/.afk/worktrees/run_...",
  "runDir": "/repo/.afk/runs/run_..."
}
```

Terminal failed runs set `ok: false`, retain available observation fields, and add `error`. Classified failures repeat `terminalFailure.category` in `error.category`.

Missing run:

```json
{
  "kind": "watch_result",
  "command": "watch",
  "ok": false,
  "backend": "local-process",
  "runId": "run_missing",
  "error": { "message": "Run run_missing not found" }
}
```

### `inspect <runId> --json`

Success contains the stored `run`, `diagnostics`, `paths`, and `derived`. `paths.runDir` is always present. `resultPath`, `finalResultPath`, `worktreePath`, and detached logs are present only when available. Parsed `finalResult`, `evidencePacket`, `pullRequest`, and `terminalFailure` are conditional.

`derived.complete` and `verificationStatus` are always present. Publishability, review, commit, and worktree-cleanliness fields appear only when authoritative evidence supplies them.

```json
{
  "command": "inspect",
  "ok": true,
  "backend": "local-process",
  "runId": "run_...",
  "run": { "id": "run_...", "workItemId": "wi_...", "status": "completed" },
  "diagnostics": {
    "runDirExists": true,
    "resultExists": true,
    "finalResultExists": true
  },
  "paths": {
    "runDir": "/repo/.afk/runs/run_...",
    "resultPath": "/repo/.afk/runs/run_.../result.json",
    "finalResultPath": "/repo/.afk/runs/run_.../final-result.json"
  },
  "finalResult": { "status": "done", "publishable": true, "whyNotPublishable": [] },
  "derived": {
    "complete": true,
    "publishable": true,
    "whyNotPublishable": [],
    "reviewVerdict": "PASS",
    "verificationStatus": "passed"
  }
}
```

Missing run:

```json
{
  "command": "inspect",
  "ok": false,
  "backend": "local-process",
  "runId": "run_missing",
  "error": { "message": "Run run_missing not found" }
}
```

### `handoff <runId> --json`

Handoff is the compact bot-facing inspection. It always returns `runId`, `workItemId`, stored `status`, `recommendedAction`, `verificationStatus`, and `runDir`. Artifact, branch, PR, evidence, and derived fields are conditional.

`recommendedAction` is `publish` for completed publishable work, `retry` for failed work, `investigate` for incomplete/running work, and `report_failure` for completed non-publishable work.

```json
{
  "command": "handoff",
  "ok": true,
  "backend": "local-process",
  "runId": "run_...",
  "workItemId": "wi_...",
  "status": "completed",
  "recommendedAction": "publish",
  "branchName": "afk/wi_...-freeze-contract",
  "pullRequest": {
    "remoteNumber": 42,
    "url": "https://github.com/acme/repo/pull/42"
  },
  "publishable": true,
  "whyNotPublishable": [],
  "reviewVerdict": "PASS",
  "verificationStatus": "passed",
  "runDir": "/repo/.afk/runs/run_...",
  "finalResultPath": "/repo/.afk/runs/run_.../final-result.json"
}
```

The missing-run failure matches `inspect` with `command: "handoff"`.

## Pull-request Publication

`run ... --pr --json` uses the `run_result` contract. `requirePullRequest` is always `true`. Success has non-null `prUrl`; its branch and pull-request reference are authoritative for later follow-up.

```json
{
  "kind": "run_result",
  "command": "run",
  "ok": true,
  "target": "file",
  "value": "brief.md",
  "backend": "local-process",
  "requirePullRequest": true,
  "detached": false,
  "workItemId": "wi_...",
  "requirementId": "req_...",
  "runId": "run_...",
  "status": "completed",
  "branchName": "afk/wi_...-freeze-contract",
  "worktreePath": "/repo/.afk/worktrees/run_...",
  "runDir": "/repo/.afk/runs/run_...",
  "resultPath": "/repo/.afk/runs/run_.../result.json",
  "finalResultPath": "/repo/.afk/runs/run_.../final-result.json",
  "finalVerdict": "done",
  "prUrl": "https://github.com/acme/repo/pull/42"
}
```

Publishing failure is classified and advertises no unavailable artifact path:

```json
{
  "kind": "run_result",
  "command": "run",
  "ok": false,
  "target": "file",
  "value": "brief.md",
  "backend": "local-process",
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

## Reviewer-directed Follow-up

`follow-up <workItemId> --json` operates on the existing AFK-created pull request and latest recorded branch/worktree. It never opens a second pull request.

```json
{
  "command": "follow-up",
  "ok": true,
  "backend": "local-process",
  "workItemId": "wi_...",
  "runId": "run_follow_up",
  "status": "completed",
  "branchName": "afk/wi_...-freeze-contract",
  "worktreePath": "/repo/.afk/worktrees/run_original",
  "prUrl": "https://github.com/acme/repo/pull/42",
  "actionableReviewComments": [{
    "id": "comment_1",
    "location": "src/app.ts:12",
    "body": "Please add error handling.",
    "path": "src/app.ts",
    "line": 12
  }],
  "addressedReviewComments": 1,
  "verification": { "status": "passed", "commands": [] }
}
```

Admission failures, such as no actionable comments, return the shared failure envelope and create no run.

If follow-up reaches review but the reviewer writes no verdict, the frozen failure contract is:

- `progress.json` remains at `phase: "review"`, iteration `1`, with `lastEvent: "review_started"`
- the foreground result has `ok: false`, `status: "failed"`, the follow-up `runId`, same branch/worktree, `prUrl`, actionable comments, and `error.message`
- `finalResultPath` is absent because no `final-result.json` exists
- `inspect` reports `diagnostics.finalResultExists: false`, omits `paths.finalResultPath`, and has `derived.complete: false`
- `handoff` omits `finalResultPath` and recommends `retry`

Repairing persistence for this runtime failure remains outside this contract. The contract records the absence rather than advertising a nonexistent authoritative artifact.

## Orchestrator Flows

Observe to handoff: retain the detached `run_result`, read the terminal `watch_result`, inspect diagnostics/evidence, then consume `handoff`. Publish only when an advertised `finalResultPath` parses with `publishable: true` and empty `whyNotPublishable`.

Publish to follow-up: require a successful `run --pr` result with `prUrl`, pass its `workItemId` to `follow-up`, and require the same branch and PR URL. On failure, consume `error` and inspect only advertised artifacts.
