# GitHub Actions Execution JSON Contract

This document freezes the public command-result envelopes for the GitHub Actions execution backend. It covers:

- `submit issue <url> --backend github-actions --json`
- `remote-runs --json`
- `remote-artifacts <run-id> --json`
- `remote-download <artifact-id> --json`

Human-readable output remains the default. Callers that need a stable interface must pass `--json`, parse the single JSON object written to stdout, and never parse terminal prose.

Versioned streaming lifecycle-event schemas are outside this contract. These commands return snapshots and do not stream lifecycle events.

## Shared Rules

The commands follow the shared command-envelope and presence conventions from the [Local Execution JSON Contract](local-execution-json-contract.md):

| Field | Presence | Nullability and meaning |
| --- | --- | --- |
| `command` | Always | Non-null command name. |
| `ok` | Always | Non-null boolean. `true` means the command achieved the result represented by the envelope. |
| `backend` | Always | Non-null and equal to `github-actions`. The backend is selected by the command, so it remains known when configuration or GitHub preflight fails. |
| `error` | Failure only | Non-null object containing exactly one non-null `message` for the currently defined remote failures. |
| `workflowId` | Submit success and every `remote-runs` envelope | Non-null string. It is absent from submit failures that occur before dispatch succeeds. |
| `correlationId` | Submit success and correlated `remote-runs` entries | Non-null string generated for one submission. The same value is passed as `correlation_id`, used as the workflow run display title, and returned by run discovery. |
| `runId` | Every `remote-artifacts` envelope | Non-null decimal string copied from the command argument. |
| `artifactId` | Every `remote-download` envelope | Non-null decimal string copied from the command argument. |
| `outputPath` | Download success only | Non-null native absolute path on the host running AFK. |

Optional GitHub values are omitted rather than set to `null`. An empty collection is represented by `runs: []` or `artifacts: []`, not by omission or `null`. IDs are strings even though GitHub represents them as numeric IDs.

Errors from argument validation, missing GitHub configuration or adapter capabilities, authentication/preflight, and GitHub API calls use the same top-level `ok: false` plus `error.message` shape. A failed command exits nonzero after writing its JSON envelope.

## Remote Submission

`submit issue` dispatches the configured repository's `afk-run.yml` workflow. GitHub's workflow-dispatch API does not return a run ID, so AFK generates a unique `correlationId` before dispatch and sends it as the required `correlation_id` workflow input. The workflow uses that exact value as its display title. Discover the created run through `remote-runs --json` by exact `correlationId` equality; do not infer or fabricate a run ID from the submit response.

### Success

```json
{
  "command": "submit",
  "ok": true,
  "target": "issue",
  "value": "https://github.com/acme/demo/issues/42",
  "backend": "github-actions",
  "workflowId": "afk-run.yml",
  "ref": "main",
  "correlationId": "dispatch_0123456789abcdef0123456789abcdef",
  "issueUrl": "https://github.com/acme/demo/issues/42",
  "requirePullRequest": true,
  "inputs": {
    "correlation_id": "dispatch_0123456789abcdef0123456789abcdef",
    "issue_url": "https://github.com/acme/demo/issues/42",
    "backend": "local-docker",
    "require_pr": "true",
    "afk_repository": "haletothewood/afk-geoff",
    "afk_ref": "main"
  }
}
```

`target`, `value`, `backend`, and `error` remain present on failure. `workflowId`, `ref`, `correlationId`, `issueUrl`, `requirePullRequest`, and `inputs` are success-only because they describe a completed dispatch. `correlationId` uses the `dispatch_` prefix followed by 32 lowercase hexadecimal characters.

### Backend preflight failure

```json
{
  "command": "submit",
  "ok": false,
  "target": "issue",
  "value": "https://github.com/acme/demo/issues/42",
  "backend": "github-actions",
  "error": {
    "message": "GitHub Actions submission requires GitHub to be configured."
  }
}
```

A GitHub API dispatch failure uses the same field presence, with the API failure text in `error.message`. If the installed workflow rejects the required `correlation_id` input, submission fails and instructs the caller to upgrade the workflow; AFK does not retry an uncorrelated legacy dispatch or return a success envelope.

## Run Discovery

`remote-runs --json` returns recent runs for a workflow. `workflowId` is the requested workflow filename or ID and is present on success and failure.

### Success

```json
{
  "command": "remote-runs",
  "ok": true,
  "backend": "github-actions",
  "workflowId": "afk-run.yml",
  "runs": [
    {
      "id": "123",
      "correlationId": "dispatch_0123456789abcdef0123456789abcdef",
      "name": "Run AFK work from issue",
      "status": "completed",
      "conclusion": "success",
      "branch": "main",
      "event": "workflow_dispatch",
      "url": "https://github.com/acme/demo/actions/runs/123",
      "createdAt": "2026-01-01T00:00:00Z",
      "updatedAt": "2026-01-01T00:01:00Z"
    }
  ]
}
```

Within each run, only `id` is always present and non-null. `correlationId` is GitHub's workflow run `display_title`; the bundled workflow guarantees that it equals the submitted `correlation_id`. It is omitted for workflows or historical runs that do not supply a display title. `name`, `status`, `conclusion`, `branch`, `event`, `url`, `createdAt`, and `updatedAt` are present only when supplied by GitHub; optional values are never emitted as `null`. A queued or in-progress run normally has `status` but omits `conclusion`.

### GitHub API failure

```json
{
  "command": "remote-runs",
  "ok": false,
  "backend": "github-actions",
  "workflowId": "afk-run.yml",
  "error": {
    "message": "GitHub API request failed"
  }
}
```

## Artifact Discovery

`remote-artifacts <run-id> --json` identifies the queried workflow run even when validation or the API request fails.

### Success

```json
{
  "command": "remote-artifacts",
  "ok": true,
  "backend": "github-actions",
  "runId": "123",
  "artifacts": [
    {
      "id": "456",
      "name": "afk-run-json",
      "sizeInBytes": 2048,
      "expired": false,
      "url": "https://api.github.com/repos/acme/demo/actions/artifacts/456",
      "archiveDownloadUrl": "https://api.github.com/repos/acme/demo/actions/artifacts/456/zip",
      "createdAt": "2026-01-01T00:02:00Z",
      "updatedAt": "2026-01-01T00:03:00Z",
      "expiresAt": "2026-04-01T00:02:00Z"
    }
  ]
}
```

Within each artifact, `id` and `name` are always present and non-null. `sizeInBytes`, `expired`, `url`, `archiveDownloadUrl`, `createdAt`, `updatedAt`, and `expiresAt` are present only when supplied by GitHub; they are never emitted as `null`. In particular, `expired: false` and `sizeInBytes: 0` are retained rather than treated as absent.

### Invalid ID or GitHub API failure

```json
{
  "command": "remote-artifacts",
  "ok": false,
  "backend": "github-actions",
  "runId": "run_123",
  "error": {
    "message": "runId must be a GitHub Actions numeric run id"
  }
}
```

An API failure has the same shape and the numeric requested `runId`, with the API failure text in `error.message`.

## Artifact Download

`remote-download <artifact-id> --json` downloads GitHub's ZIP archive. The result reports the artifact ID, the resolved host path, and the written byte count. Consumers should use `outputPath` rather than construct `.afk/remote-artifacts` paths.

### Success

```json
{
  "command": "remote-download",
  "ok": true,
  "backend": "github-actions",
  "artifactId": "456",
  "outputPath": "/repo/downloaded.zip",
  "bytes": 9
}
```

### Invalid ID or GitHub API failure

```json
{
  "command": "remote-download",
  "ok": false,
  "backend": "github-actions",
  "artifactId": "artifact_456",
  "error": {
    "message": "artifactId must be a GitHub Actions numeric artifact id"
  }
}
```

An API or filesystem write failure has the same shape and the requested numeric `artifactId`, with the failure text in `error.message`. `outputPath` and `bytes` are absent unless the download and write both succeed.

## Orchestrator Flow

An external orchestrator can complete the remote submit-to-artifact-discovery path without terminal-prose parsing:

1. Dispatch with `submit issue <url> --backend github-actions --json` and retain `workflowId`, `ref`, and `correlationId`.
2. Poll `remote-runs --workflow <workflowId> --json`, select the single run whose `correlationId` exactly equals the submission's `correlationId`, and retain its `id`, `status`, `conclusion`, and `url`.
3. After the run reaches a terminal status, call `remote-artifacts <run-id> --json` and select an unexpired artifact by `name`, retaining its `id` and URLs.
4. If local bytes are needed, call `remote-download <artifact-id> --json` and consume `outputPath`.

The workflow-dispatch API creates an unavoidable discovery boundary between steps 1 and 2: submit does not claim a run ID that GitHub did not return. The stable correlation value makes that boundary deterministic even when multiple submissions use the same workflow and ref concurrently.
