# Agent Orchestrator Quickstart

Use this when another agent session, harness, scheduler, Slack bot, Linear bot, GitHub app, or CI job needs to drive AFK Geoff as a backend worker.

AFK is the execution substrate. The orchestrator chooses the work, starts a run, watches progress, and uses the handoff payload to decide what to do next.

## Non-Negotiable Rule

Using AFK Geoff means invoking the AFK CLI.

Do not replace AFK with:

- a Codex subagent
- a Claude subagent
- a generic task tool
- manual edits in the target repo
- a persona named "Geoff"

A valid AFK run creates a `runId`, a `.afk/runs/<runId>/` directory, and usually a `.afk/worktrees/<runId>/` worktree. If no `afk run ...` command was executed, no AFK worker was spawned.

## 0. Locate The AFK CLI

First, choose the command prefix the orchestrator will use for every AFK command.

If `afk` is on `PATH`:

```bash
afk() { command afk "$@"; }
```

If `afk` is not on `PATH`, use this checkout directly:

```bash
afk() { /opt/homebrew/bin/node "/Users/david/Documents/AFK Geoff/packages/cli/bin/afk.js" "$@"; }
```

For a one-off installed CLI in a target repo, use:

```bash
pnpm dlx afk-geoff --help
```

Then run:

```bash
afk doctor --json
```

All command examples below assume that shell function or an equivalent `afk` executable is available.

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

For another agent CLI, configure a custom command in `.afk/config.yaml`:

```yaml
runner:
  kind: custom
  command: ["other-agent", "run", "{prompt}"]
  reviewCommand: ["other-agent", "review", "{prompt}"]
  requiredEnv: []
```

AFK supplies the prompt path through `{prompt}`. Use `runner.reviewCommand` when implementation and review should use different agents, such as Claude for work and Codex for review.

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
