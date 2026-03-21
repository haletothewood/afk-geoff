# AFK Execution Brief

## Requirement
AFK now has the beginnings of live run progress, but it still lacks the reliability guardrail that matters most for unattended execution: hung runs can sit in `running` forever. Once a worker stops making progress, the operator needs AFK to detect that condition, fail the run cleanly, and leave the queue in a recoverable state instead of requiring manual diagnosis.

## Work Item Title
Add run timeouts and heartbeat expiry handling

## Work Item Body
Implement timeout and stale-heartbeat handling for active AFK work runs.

AFK should treat the run directory as the source of truth and use the existing `progress.json` heartbeat data to decide whether a worker is still alive. The feature should cover both of these cases:
- the worker process never finishes and stops updating progress
- the worker process keeps existing but the progress heartbeat goes stale beyond an allowed threshold

Add explicit timeout configuration for work runs and fail them predictably when either:
- the overall run exceeds its configured time budget, or
- the progress heartbeat has not been updated within a configured stale window

When AFK marks a run as failed for one of these reasons, it should:
- set the run status to `failed`
- move the work item out of `in_progress`
- record a clear summary that distinguishes timeout from stale heartbeat from ordinary worker failure

Keep the implementation portable and focused on the existing local Docker backend. Do not add Docker-specific inspection. Use the run directory and existing run lifecycle paths so this also fits future detached mode and watch mode cleanly.

Do not block on cancellation or background execution in this task. This feature is specifically about failing hung runs cleanly and predictably.

## Acceptance Criteria
- AFK supports configurable timeout values for work runs and heartbeat staleness checks.
- A run with a stale or missing heartbeat beyond the configured window is marked `failed` automatically.
- A run that exceeds the configured overall timeout is marked `failed` automatically.
- The failed run summary clearly identifies whether the failure was caused by timeout or stale heartbeat.
- The affected work item is no longer left in `in_progress` after timeout expiry.
- CLI tests cover both timeout and stale-heartbeat failure paths.

## Verification
- pnpm typecheck
- pnpm test -- packages/cli/src/index.test.ts
