# BDD Scenarios

This document maps the main user-facing commands to domain behavior and provides the canonical scenarios for the repository.

Use these scenarios as the source for:

- acceptance tests
- workflow smoke tests
- adapter-boundary tests
- future Gherkin or story files

Terms in this document follow [Ubiquitous Language](/Users/davidneil/Development/Personal/AI-Workflows/docs/ubiquitous-language.md).

## Command Matrix

| Command | Primary Domain Effect | Important Observable Outcomes |
|---|---|---|
| `aiwf init` | creates project scaffold | `.ai-workflows/config.yaml` and `.ai-workflows/.gitignore` exist |
| `aiwf doctor` | validates runtime dependencies | required executables and env vars are present |
| `aiwf capture` | creates a `Requirement` | requirement exists in SQLite; requirement may be mirrored |
| `aiwf plan` | creates a draft plan | draft `WorkItem`s exist with dependency relationships |
| `aiwf approve` | promotes draft plan into the approved queue | AFK items become `todo` or `blocked`; HITL items become `hitl_pending` |
| `aiwf status` | reports queue state after lightweight sync | queue output reflects current work item states |
| `aiwf dispatch` | starts autonomous execution for runnable AFK work | work runs and run artifacts are created |
| `aiwf run` | executes one specific work item | work item moves through `in_progress` to terminal state |
| `aiwf review` | prepares a manual HITL review run | review run and `review.md` brief are created |
| `aiwf sync` | reconciles mirrored remote state into SQLite | mirrored state updates local statuses |

## Core Scenarios

### Scenario: Approving a planned requirement creates an actionable queue

```gherkin
Given a captured requirement
When the requirement is planned
And the requirement is approved
Then independent AFK work items should become todo
And dependent AFK work items should become blocked
And HITL work items should become hitl_pending
```

Covered by:

- [packages/cli/src/index.test.ts](/Users/davidneil/Development/Personal/AI-Workflows/packages/cli/src/index.test.ts)
- [packages/core/src/usecases.test.ts](/Users/davidneil/Development/Personal/AI-Workflows/packages/core/src/usecases.test.ts)

### Scenario: Completing a dependency makes blocked work runnable

```gherkin
Given an approved requirement with a blocked AFK work item
And its dependency is runnable
When the dependency completes
And status is refreshed
Then the blocked AFK work item should become todo
```

Covered by:

- [packages/cli/src/index.test.ts](/Users/davidneil/Development/Personal/AI-Workflows/packages/cli/src/index.test.ts)
- [packages/core/src/usecases.test.ts](/Users/davidneil/Development/Personal/AI-Workflows/packages/core/src/usecases.test.ts)

### Scenario: Preparing review for HITL work creates a review brief

```gherkin
Given an approved requirement with a HITL work item
When review is prepared for that work item
Then a review run should be created
And the run should include review.md
And the review brief should contain the requirement, work item, and acceptance criteria
```

Covered by:

- [packages/cli/src/index.test.ts](/Users/davidneil/Development/Personal/AI-Workflows/packages/cli/src/index.test.ts)
- [packages/core/src/usecases.ts](/Users/davidneil/Development/Personal/AI-Workflows/packages/core/src/usecases.ts)

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

- [packages/cli/src/index.test.ts](/Users/davidneil/Development/Personal/AI-Workflows/packages/cli/src/index.test.ts)
- [packages/adapter-github/src/index.test.ts](/Users/davidneil/Development/Personal/AI-Workflows/packages/adapter-github/src/index.test.ts)

## Adapter-Boundary Scenarios

These scenarios are intentionally adapter-specific and may use GitHub terms directly.

### Scenario: A requirement mirror is a labeled parent issue

```gherkin
Given a requirement is mirrored to GitHub
Then the remote issue should include the aiwf:requirement label
And the issue body should include the requirement marker comment
```

### Scenario: A work item mirror is a labeled child issue

```gherkin
Given a work item is mirrored to GitHub
Then the remote issue should include the aiwf:work-item label
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
