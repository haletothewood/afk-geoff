# AFK Execution Brief

## Requirement
AFK runs are still too opaque while they are in progress. An operator can see that a run exists and can inspect logs, but cannot easily tell whether the worker is alive, what phase it is in, or whether it is making forward progress. The next step is to add explicit run progress reporting and heartbeat data so active jobs become observable.

## Work Item Title
Add live run progress and heartbeat reporting

## Work Item Body
Implement a progress reporting mechanism for active AFK work runs.

The worker should periodically write structured progress data into the run directory, using a stable file such as `/afk-run/progress.json`. The intent is not to expose every internal model detail, but to provide enough operator-facing state to answer basic questions like:
- is the run still alive?
- what phase is it in?
- what iteration or step is it currently on?

At minimum, the progress payload should include:
- `phase`
- `message`
- `iteration`
- `updatedAt`

Use the existing run directory as the source of truth so this works for the current local Docker backend without requiring Docker-specific introspection. Then surface that progress in the CLI:
- `pnpm afk status` should show useful progress for active runs
- `pnpm afk show <work-item-id>` should expose the latest known progress for the relevant run

Keep the implementation modest and portable. This feature should improve visibility for the current backend while fitting the port/adaptor shape already in place.

Do not block on token accounting or runner-specific metrics. If a runner cannot cheaply provide more detail, AFK should still report heartbeat and phase cleanly.

## Acceptance Criteria
- Active work runs write a structured progress file into the run directory.
- The progress payload includes at least `phase`, `message`, `iteration`, and `updatedAt`.
- `pnpm afk status` shows live progress details for active runs instead of only `running`.
- `pnpm afk show <work-item-id>` includes the latest progress details for the active run when available.
- CLI tests cover progress visibility for an active run.

## Verification
- pnpm typecheck
- pnpm test -- packages/cli/src/index.test.ts
