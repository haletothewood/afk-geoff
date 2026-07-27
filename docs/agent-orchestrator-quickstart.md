# Agent Orchestrator Quickstart

Use this when another agent session, harness, scheduler, Slack bot, Linear bot, GitHub app, or CI job needs to drive AFK Geoff as a backend worker.

AFK is the execution substrate. The orchestrator chooses the work, starts a run, watches progress, and uses the handoff payload to decide what to do next.

## 1. Confirm The Target Repo

Run these from the target repository, not from the AFK Geoff repository:

```bash
git status --short --branch
git remote -v
```

If the run should publish a pull request, the repo needs a GitHub `origin` remote and GitHub publishing enabled in `.afk/config.yaml`:

```yaml
github:
  enabled: true
```

## 2. Configure A Local Runner

For a real Codex-backed local run:

```bash
afk init --runner-profile codex
```

For a real Claude-backed local run:

```bash
afk init --runner-profile claude
```

For a no-key orchestration smoke test:

```bash
afk init --runner-profile smoke
git add .afk/config.yaml .afk/smoke-runner.mjs
git commit -m "configure afk smoke runner"
```

Local runner profiles use the host CLI authentication that already exists on the machine. They do not require API key environment variables by default.

## 3. Create A Brief

Write a focused execution brief:

```markdown
# AFK Execution Brief

## Requirement

Describe the small change AFK should make.

## Work Item Title

Short imperative title

## Work Item Body

Concrete implementation context, constraints, and files or behavior to inspect.

## Acceptance Criteria

- The behavior change is implemented
- Relevant tests or checks pass
- The final worktree is clean

## Verification

- pnpm run typecheck
- pnpm test -- --runInBand path/to/focused.test.ts
```

Keep the first run small. AFK works best when each brief describes one reviewable slice.

## 4. Preflight

```bash
afk doctor --json
```

Proceed only when the payload has:

```json
{"ok":true}
```

If `ok` is false, report the structured failures and stop.

## 5. Start A Detached Run

Without PR publishing:

```bash
afk run file brief.md --detach --json
```

With PR publishing required:

```bash
afk run file brief.md --detach --pr --json
```

`run --json` emits NDJSON. Capture the final `kind: "run_result"` line and store:

- `runId`
- `workItemId`
- `branchName`
- `runDir`
- `worktreePath`
- `detachLogPaths`

If the final line has `ok: false`, report `error.message` and stop.

## 6. Watch The Run

```bash
afk watch <runId> --json
```

`watch --json` emits progress events and ends with `kind: "watch_result"`.

If `watch_result.ok` is false, run:

```bash
afk handoff <runId> --json
```

Then report the handoff payload and any `detachLogPaths` from the original run result.

## 7. Read The Handoff

```bash
afk handoff <runId> --json
```

Use this payload as the orchestrator's final decision surface.

Important fields:

- `recommendedAction`
- `status`
- `branchName`
- `pullRequest.url`
- `publishable`
- `reviewVerdict`
- `verificationStatus`
- `createdCommitCount`
- `worktreeClean`
- `runDir`
- `finalResultPath`
- `worktreePath`

Recommended action meanings:

- `publish`: completed and publishable
- `retry`: failed
- `investigate`: still running, incomplete, or missing final result
- `report_failure`: completed but not publishable

## 8. Report The Result

For a successful PR handoff, report:

- run id
- work item id
- branch
- pull request URL
- recommended action
- review verdict
- verification status
- created commit count
- worktree clean status
- final result path

Do not declare success from terminal prose alone. Use `handoff --json` or, for detailed diagnostics, `inspect --json`.

## 9. Follow Up On Review Comments

If an AFK-created pull request receives actionable review comments:

```bash
afk follow-up <workItemId> --json
```

The follow-up run works on the existing PR branch and pushes follow-up commits to the same pull request.

## Minimal Command Sequence

```bash
afk doctor --json
afk run file brief.md --detach --pr --json
afk watch <runId> --json
afk handoff <runId> --json
```

That is the canonical local orchestrator loop.
