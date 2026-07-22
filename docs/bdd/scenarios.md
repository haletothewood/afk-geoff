# BDD Scenarios

This document maps the main user-facing commands to domain behavior and provides the canonical scenarios for the repository.

Use these scenarios as the source for:

- acceptance tests
- workflow smoke tests
- adapter-boundary tests
- future Gherkin or story files

Terms in this document follow [Ubiquitous Language](../ubiquitous-language.md).

## Command Matrix

| Command | Primary Domain Effect | Important Observable Outcomes |
|---|---|---|
| `afk init` | creates project scaffold | `.afk/config.yaml`, `.afk/.gitignore`, and `.afk/iteration-loop.md` exist |
| `afk doctor` | validates runtime dependencies | required executables and env vars are present; `--json` reports structured preflight status |
| `afk capture` | creates a `Requirement` | requirement exists in SQLite; requirement may be mirrored |
| `afk status` | reports queue state after lightweight sync | queue output reflects current work item states |
| `afk dispatch` | starts autonomous execution for runnable AFK work | work runs and run artifacts are created |
| `afk run` | executes one specific work item | work item moves through `in_progress` to terminal state |
| `afk submit` | submits work to a remote execution harness | GitHub Actions workflow dispatch is requested with structured JSON output |
| `afk review` | prepares a manual HITL review run | review run and `review.md` brief are created |
| `afk follow-up` | addresses review comments on an AFK-created pull request | existing PR branch receives follow-up commits |
| `afk --json` command variants | exposes orchestration state to external harnesses | stdout is one structured JSON payload with stable ids and URLs |
| `afk sync` | reconciles mirrored remote state into SQLite | mirrored state updates local statuses |
| GitHub Actions `AFK Run` workflow | remotely executes issue-backed AFK work | workflow dispatch accepts an issue URL and runs AFK with JSON output |

## Core Scenarios

### Scenario: Completing a dependency makes blocked work runnable

```gherkin
Given an approved requirement with a blocked AFK work item
And its dependency is runnable
When the dependency completes
And status is refreshed
Then the blocked AFK work item should become todo
```

Covered by:

- `packages/cli/src/__tests__/dispatch.test.ts`
- `packages/core/src/usecases.test.ts`

### Scenario: Preparing review for HITL work creates a review brief

```gherkin
Given an approved requirement with a HITL work item
When review is prepared for that work item
Then a review run should be created
And the run should include review.md
And the review brief should contain the requirement, work item, and acceptance criteria
```

Covered by:

- `packages/cli/src/__tests__/review.test.ts`
- `packages/core/src/usecases.ts`

### Scenario: Only actionable work items are mirrored to GitHub

```gherkin
Given GitHub mirroring is enabled
And a requirement has been captured
When the requirement is approved
Then the requirement should already be mirrored
And todo AFK work items should be mirrored
And hitl_pending work items should be mirrored
And blocked work items should not be mirrored yet
When a blocked AFK work item becomes todo
Then that work item should be mirrored
```

Covered by:

- `packages/cli/src/__tests__/run.test.ts`
- `packages/adapter-github/src/index.test.ts`

### Scenario: Follow-up on an AFK-created pull request reuses the PR branch

```gherkin
Given an AFK work item has opened a pull request
And the pull request has review comments
When follow-up runs for that work item
Then AFK should run against the existing PR branch
And push follow-up commits to the same pull request
And report how many review comments were addressed
```

Covered by:

- `packages/cli/src/__tests__/follow-up.test.ts`
- `packages/adapter-github/src/index.test.ts`

### Scenario: JSON command output is usable by an external orchestrator

```gherkin
Given AFK is driven by another agent framework or automation harness
When a supported command is run with --json
Then stdout should contain one parseable JSON payload
And the payload should include stable work item ids, run ids, statuses, branches, worktree paths, and pull request URLs when available
And normal human-readable progress output should not be mixed into stdout
And failing run commands should include `ok: false` with a structured error message before exiting nonzero
```

Covered by:

- `packages/cli/src/__tests__/json-output.test.ts`

## Adapter-Boundary Scenarios

These scenarios are intentionally adapter-specific and may use GitHub terms directly.

### Scenario: GitHub Actions can run issue-backed AFK work

```gherkin
Given an external orchestrator has a GitHub issue URL containing an AFK execution brief
When it runs `afk submit issue <issue-url> --backend github-actions --json`
Then AFK should dispatch the AFK Run workflow with that issue URL
And the JSON payload should include the workflow id, ref, backend, and dispatch inputs
When the workflow starts
Then the workflow should run `afk doctor --json`
And execute `afk run issue <issue-url> --backend local-docker --json`
And require pull request publication when the `require_pr` input is true
```

Covered by:

- `packages/cli/src/__tests__/json-output.test.ts`
- `packages/adapter-github/src/index.test.ts`

### Scenario: A requirement mirror is a labeled parent issue

```gherkin
Given a requirement is mirrored to GitHub
Then the remote issue should include the afk:requirement label
And the issue body should include the requirement marker comment
```

### Scenario: A work item mirror is a labeled child issue

```gherkin
Given a work item is mirrored to GitHub
Then the remote issue should include the afk:work-item label
And the remote issue should include the AFK or HITL label
And the issue body should include the work item marker comment
```

### Scenario: Sync imports remote state but not remote authorship

```gherkin
Given a mirrored issue or pull request exists
When GitHub state is synced
Then open or closed state should be imported
And comments should be imported
But manual body edits should not rewrite the local domain model in v1
```

## Recommended Test Layers

Use this split when adding coverage:

- `packages/core`
  Test pure queue logic and state transitions.
- `packages/cli`
  Test user-visible workflow scenarios end to end with fake runner and fake Docker.
- `packages/adapter-github`
  Test issue and pull request payloads, labels, and sync mapping.
- `scripts/developer-workflow-smoke.ts`
  Keep one black-box smoke path that runs the real CLI the way a developer would.

## Adding New Scenarios

When adding a feature:

1. Define the scenario here in domain language.
2. Add or update tests at the narrowest layer that can prove the behavior.
3. Add or extend the smoke test only if the behavior is part of the normal developer workflow.
