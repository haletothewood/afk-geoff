# Ubiquitous Language

This document defines the shared language for afk-geoff. Use these terms in code, tests, docs, commit messages, and BDD scenarios.

## Purpose

The goal is to keep business language stable even when adapters change. SQLite may remain local, GitHub may be enabled or disabled, and runners may change from Claude to Codex, but the domain language should stay the same.

## Core Terms

### Requirement

A `Requirement` is the top-level statement of work captured from a user prompt or other input.

- It describes the problem or desired outcome.
- It is the parent object for a set of work items.
- Its status is one of: `captured`, `planned`, `approved`, `completed`.

Use in scenarios:

- `Given a captured requirement`
- `Then the requirement status should be approved`

Do not casually replace this with “issue”, “epic”, or “ticket”. A GitHub issue may mirror a requirement, but it is not the requirement itself.

### Work Item

A `WorkItem` is a single actionable unit of work derived from a requirement.

- It belongs to exactly one requirement.
- It has a `planKey`, title, body, acceptance criteria, and execution summary.
- It may depend on other work items.

Its status is one of:

- `draft`
- `todo`
- `blocked`
- `in_progress`
- `hitl_pending`
- `done`
- `failed`

Use “work item” instead of “task”, “ticket”, or “job” unless the distinction is intentionally technical.

### Dependency

A dependency is a relationship where one work item cannot progress until another work item is `done`.

Use “dependency” for the graph relationship.
Use “blocked” for the current status caused by unresolved dependencies.

BDD phrasing:

- `Given a work item depends on another work item`
- `When the dependency is done`
- `Then the blocked work item becomes todo`

### AFK Work Item

An AFK work item is a `WorkItem` with `type = "afk"`.

- It is intended for autonomous execution.
- It can be dispatched automatically when its status is `todo`.

BDD phrasing:

- `Given a todo AFK work item`
- `When dispatch runs`
- `Then the work item should start a work run`

### HITL Work Item

A HITL work item is a `WorkItem` with `type = "hitl"`.

- HITL means “human in the loop”.
- It is not auto-dispatched.
- Its active queue status is `hitl_pending`.
- It is handled through the `review` flow.

BDD phrasing:

- `Given a HITL work item`
- `When review is prepared`
- `Then a review brief should be created`

Do not call HITL work “blocked”. HITL is a deliberate classification, not a failure state.

### Approved Queue

The approved queue is the set of non-draft work items once actionable work has been created in local state.

After approval:

- AFK items with satisfied dependencies become `todo`
- AFK items with unresolved dependencies become `blocked`
- HITL items become `hitl_pending`

BDD phrasing:

- `When a requirement is approved`
- `Then each draft work item should transition into the approved queue`

### Dispatch

Dispatch is the act of selecting runnable AFK work items and starting autonomous execution.

- Dispatch operates on `todo` AFK work items.
- Dispatch does not operate on `blocked` items.
- Dispatch does not operate on `hitl_pending` items.

Use “dispatch” for queue selection and launch, not for the execution itself.

### Run

A `RunRecord` represents a concrete execution or preparation attempt associated with a work item.

Run modes:

- `work`
- `review`

Run statuses:

- `prepared`
- `running`
- `completed`
- `failed`

Use “run” when talking about an observed execution attempt, not the abstract work item.

### Work Run

A work run is a run with `mode = "work"`.

- It prepares a worktree and run directory.
- It executes the configured runner through the workspace runtime.
- It expects a `result.json` outcome.

### Review Run

A review run is a run with `mode = "review"`.

- It prepares a worktree for manual investigation.
- It writes a `review.md` brief.
- It does not auto-dispatch a containerized worker.

### Run Artifacts

Run artifacts are files produced under `.afk/runs/<run-id>/`.

Key artifacts include:

- `manifest.json`
- `prompt.md`
- `stdout.log`
- `stderr.log`
- `result.json`
- `review.md` for review runs

Use “run artifacts” for these files, not “logs” as a blanket term.

### Worktree

A worktree is the isolated git checkout used for a run.

- Worktrees live under `.afk/worktrees/<run-id>/`.
- A run may have a branch name associated with its worktree.

### Result

A result is the structured worker outcome stored in `result.json`.

The authoritative worker result includes:

- `status`
- `summary`
- `issueComment`
- optional PR metadata

Do not refer to stdout parsing as the result. Stdout and stderr are diagnostic logs only.

### Review Brief

A review brief is the human-facing document created for a HITL review run.

- It summarizes the requirement, work item, acceptance criteria, and dependencies.
- It is intended to be opened in an interactive tool such as Claude Code.

### Mirror

A mirror is a representation of domain state in an external system such as GitHub.

- Requirements may be mirrored as parent issues.
- Actionable work items may be mirrored as child issues.
- Change requests may be mirrored as pull requests.

Use “mirror” to make it clear the external object is derived from local state.

### External Reference

An `ExternalRef` links a domain entity to a mirrored remote object.

- It identifies the provider, remote type, and remote number.
- It is a pointer, not the source of truth.

### Change Request

A `ChangeRequest` is the domain concept for a proposed code change.

- In GitHub, it is mirrored as a pull request.
- It belongs to a work item and references a branch.

Use “change request” in domain language and “pull request” only when specifically talking about GitHub.

### Sync

Sync is the act of reconciling selected remote state back into the local store.

- Sync is lightweight and adapter-specific.
- Sync does not make GitHub authoritative.
- Sync updates mirrored state such as issue state, comments, and PR state.

## Source Of Truth Rules

These rules should appear consistently in tests and docs:

- SQLite is the source of truth.
- GitHub is a mirror and collaboration surface.
- Manual edits in GitHub issue bodies are non-authoritative in v1.
- `result.json` is the authoritative worker outcome for a work run.

## BDD Writing Rules

Use the exact domain terms above in scenarios.

Preferred pattern:

- `Given` domain state
- `When` a command or use case runs
- `Then` observable domain state changes

Prefer scenario language like:

- `Given an approved requirement with one todo AFK work item`
- `When dispatch runs`
- `Then a work run should be created`

Avoid adapter-heavy phrasing like:

- `Given a GitHub issue exists`
- `When Octokit updates labels`

That kind of wording is appropriate only in adapter-level tests.

## Scenario Examples

### Dependency resolution

```gherkin
Scenario: Completing a dependency makes blocked work runnable
  Given an approved requirement with a blocked AFK work item
  And the blocking work item is done
  When status is refreshed
  Then the blocked AFK work item should become todo
```

### HITL review preparation

```gherkin
Scenario: Preparing review for a HITL work item creates a review brief
  Given an approved requirement with a HITL work item
  When review is prepared for that work item
  Then a review run should be created
  And the run should include a review brief
```

## Terms To Avoid

Avoid these substitutions unless you are explicitly discussing an adapter:

- “issue” when you mean `Requirement` or `WorkItem`
- “PR” when you mean `ChangeRequest`
- “cache” when you mean the SQLite store
- “blocked” when you mean HITL
- “output” when you mean `result.json`
- “task system” when you specifically mean the approved queue or a work item

## Mapping To Commands

- `capture` creates a `Requirement`
- `status` reports queue state after lightweight sync
- `dispatch` starts autonomous execution for runnable AFK work items
- `run` executes a specific work item directly
- `review` prepares a manual review run for a HITL work item
- `sync` reconciles mirrored remote state into the local store
