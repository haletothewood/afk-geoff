# Lifecycle Event Contract

AFK commands that expose workflow progress as NDJSON use the versioned lifecycle-event
contract defined here. Version 1 is a closed vocabulary: consumers may switch on every
documented event name and validate every event with the shared `lifecycleEventSchema`.

Every lifecycle event has this envelope:

```json
{
  "kind": "run_event",
  "schemaVersion": 1,
  "timestamp": "2026-01-01T00:00:00.000Z",
  "event": "verification_started"
}
```

`timestamp` is the producer time in ISO 8601 UTC form. Run-scoped events also identify
`runId` and `workItemId`. Stage execution events carry a one-based `attempt` and a
`reused` flag. Completion events carry `durationMs` where AFK measures the stage.

## Version 1 vocabulary

| Event | Meaning and typed payload |
| --- | --- |
| `run_requested` | Admission request: `target`, optional `value`. |
| `run_started` | Tracked run identity and paths; stage `run`, attempt 1, not reused. |
| `package_manager_warning` | Non-fatal package-manager diagnostic: `message`. |
| `worker_started` | Work or follow-up execution: stage metadata, iteration, phase, command, result path. |
| `fix_started` | Fix execution: stage metadata, iteration, command, result path. |
| `worker_completed` | Work, fix, or follow-up outcome: duration, status, message, result path. |
| `verification_started` | Verification attempt and iteration. |
| `verification_completed` | Verification duration, status, and summary message. |
| `verification_issues` | Non-empty normalized issue list and issue count. |
| `review_started` | Reviewer attempt, iteration, command, and result path. |
| `review_issues` | `ISSUES` verdict, duration, non-empty issue list, and result path. |
| `review_completed` | `PASS` or `BLOCKED` verdict, duration, issue count, and result path. |
| `run_completed` | Terminal workflow observation: status, run directory, optional result path and classified failure. |
| `generated_artifacts_cleaned` | Generated paths removed before continuing an iteration. |
| `watch_started` | Watch attachment with current run state and watch-stage metadata. |
| `run_observed` | Initial state observed by watch. |
| `progress_observed` | Changed progress with phase, iteration, message, and `progressUpdatedAt`. |
| `heartbeat_stale` | Unchanged progress with `progressUpdatedAt`, `heartbeatAgeMs`, and `staleThresholdMs`. |
| `run_failed` | Failed state observed by watch, including a classified failure when available. |
| `evidence_reused` | Retry provenance: source run, reused stages, and retried stage. |

Unknown event names, missing required fields, invalid field types, and undeclared fields
are invalid. Producers construct events through `createLifecycleEvent`, which validates
the complete object before it reaches stdout.

## Streams and authoritative artifacts

Lifecycle events describe AFK workflow state. They are not a runner-native agent event
stream: future token, tool-call, or model telemetry must use a separate event kind and
contract. Raw runner logs remain artifacts rather than lifecycle events.

An NDJSON command always retains its terminal command-result line after zero or more
lifecycle events. Consumers must continue reading until that result:

```json
{"kind":"run_result","command":"run","ok":true,"runId":"run_...","status":"completed"}
```

Verification recovery ends with the corresponding retry envelope:

```json
{"kind":"retry_result","command":"retry","ok":true,"runId":"run_...","status":"done"}
```

Events are observational and do not replace persisted authority. `result.json` is the
authoritative worker outcome. `final-result.json` is the authoritative completed-run,
verification, review, recovery, terminal-failure, and publishability artifact.

## Compatibility

Version 1 preserves the lifecycle event names and domain fields emitted before the
contract was formalized, while adding the versioned envelope and explicit timing,
stage, attempt, duration, and reuse metadata.

The v1 schemas are strict. Adding or removing an event, adding or removing an allowed
field, changing field meaning, or changing a field's type requires a new
`schemaVersion`. A producer may support more than one version, but must emit exactly
one schema version per event. Consumers should reject unsupported versions instead of
guessing their meaning.

Frozen v1 NDJSON examples live in
`packages/cli/src/__tests__/fixtures/lifecycle-events-v1`. They cover successful
foreground execution, detached observation, verification/review failure,
orchestrator failure, publishing failure, and retry with reused evidence.
