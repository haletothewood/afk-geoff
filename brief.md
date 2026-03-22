# AFK Execution Brief

## Requirement

AFK should operate as a reusable orchestrator across many repositories with a stable loop: human-guided planning, autonomous implementation run, PR, and human-guided review/follow-up. The next capability gap is runner and model control: operators need explicit, predictable defaults for implementation runs and review runs so they can tune cost, speed, and quality without changing code.

## Work Item Title

Add configurable model selection and runner presets

## Work Item Body

Implement runner/model presets so AFK resolves the execution engine and model posture explicitly before autonomous work starts.

Scope:
- add config-level defaults for runner/model selection
- support separate defaults for implementation runs and review runs
- resolve and surface chosen runner/model in operator-facing output before run start
- keep execution modes as independent posture guidance; runner/model selection must not replace mode selection
- keep repository instructions and required verification as hard floor constraints
- fail clearly when a configured model is unsupported by the selected runner
- keep the abstraction vendor-neutral in core interfaces (`modelId` / model preference rather than provider-specific labels)
- cover configuration parsing, resolution, validation, and run-path propagation with tests

### Out of Scope

- PR comment resolution pass on existing PR branches
- automatic model switching based on token/cost telemetry
- provider-specific tuning knobs in core domain interfaces
- full remote execution backend rollout

## Acceptance Criteria

- AFK config supports default runner/model selection for work and review phases.
- Work runs and review runs resolve to the configured defaults without hidden fallbacks.
- AFK prints the resolved runner/model before execution starts.
- Invalid runner/model combinations fail fast with actionable error messages.
- Existing execution-mode guidance remains intact and continues to propagate to worker prompts.
- Tests cover config parsing, validation, and propagation through work and review execution paths.
- `pnpm typecheck` passes.
- `pnpm test` passes.

## Design Decisions

| Decision | Resolution |
|----------|-----------|
| Selection model | Config-level defaults with separate work vs review presets |
| Core abstraction | Use vendor-neutral model identifiers |
| Error policy | Fail fast on unsupported model/runner combinations |
| Operator visibility | Print resolved runner/model before run start |
| Safety model | Repository instructions and required verification remain non-overridable |

## Known Risks

- Different runners may expose model lists differently, making capability validation brittle.
- Operators may assume runner/model presets also change execution mode; docs and output must keep this distinction explicit.
- Misconfigured defaults could create hidden cost spikes if not surfaced clearly in run-start output.

## Verification

- pnpm typecheck
- pnpm test
