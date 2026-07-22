# AFK Execution Brief

## Requirement

AFK should operate as a reusable orchestrator across many repositories with a stable loop: human-guided planning, autonomous implementation run, PR, and human-guided review/follow-up. The next capability gap is runner and model control: operators need explicit, predictable defaults for implementation runs and review runs so they can tune cost, speed, and quality without changing code.

## Work Item Title

Add PR comment resolution pass

## Work Item Body

Implement a follow-up execution pass that starts from an existing AFK-created pull request and reviewer feedback.

Scope:
- ingest unresolved review comments from an open pull request
- run against the existing PR branch instead of creating a new branch
- push follow-up commits to the same PR
- report what comments were addressed and what verification ran
- scope v1 to AFK-created pull requests
- do not auto-resolve review comments in v1
- keep repository instructions and required verification as hard floor constraints

### Out of Scope

- automatic model switching based on token/cost telemetry
- provider-specific tuning knobs in core domain interfaces
- full remote execution backend rollout
- non-GitHub pull request providers
- auto-resolving GitHub review threads

## Acceptance Criteria

- AFK can identify an open AFK-created pull request for follow-up.
- AFK gathers actionable unresolved review comments for that pull request.
- The follow-up run uses the existing PR branch and pushes any fix commits back to it.
- Operator output summarizes addressed comments and verification results.
- Existing execution-mode and runner/model guidance remain intact.
- Tests cover comment ingestion, branch reuse, publication to the existing PR, and blocked/failure paths.
- `pnpm typecheck` passes.
- `pnpm test` passes.

## Design Decisions

| Decision | Resolution |
|----------|-----------|
| Selection model | Existing AFK-created PRs only for v1 |
| Core abstraction | Keep PR feedback behind adapter ports |
| Error policy | Fail clearly when PR comments or branch state cannot be resolved |
| Operator visibility | Print addressed comments and verification summary |
| Safety model | Repository instructions and required verification remain non-overridable |

## Known Risks

- GitHub review thread resolution state may require GraphQL or richer adapter support than issue-style comments.
- Running on an existing branch must avoid accidentally creating a second PR or overwriting unrelated commits.
- Review comments can be vague; BLOCKED needs to remain a first-class outcome.

## Verification

- pnpm typecheck
- pnpm test
