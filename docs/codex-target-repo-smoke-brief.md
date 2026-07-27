# Agent Brief: Test AFK Geoff Local Runner Prototype

## Goal

Use AFK Geoff as a local orchestration layer for repo work. First prove the keyless smoke path, then assess what is needed to run a real local Codex agent.

## Context

AFK Geoff lives at:

```text
/Users/david/Documents/AFK Geoff
```

From another repo, invoke the AFK CLI directly with:

```bash
"/Users/david/Documents/AFK Geoff/packages/cli/bin/afk.js" <command>
```

If that hits a native `better-sqlite3` Node ABI mismatch, invoke AFK with the Homebrew Node binary:

```bash
/opt/homebrew/bin/node "/Users/david/Documents/AFK Geoff/packages/cli/bin/afk.js" <command>
```

AFK Geoff currently supports local runner profiles:

- `smoke`: deterministic no-key runner; proves orchestration without real code changes
- `claude`: local Claude CLI runner
- `codex`: local Codex CLI runner

Local runner profiles use AFK's `local-process` backend. That means AFK still creates isolated run state and a git worktree, but invokes the configured runner on the host machine so local CLI auth, such as `~/.codex`, can be used.

## Task

In the target repo, run a local AFK smoke test and report the results.

## Steps

1. Inspect repo state.

```bash
git status --short --branch
git branch --show-current
```

2. Initialize AFK smoke mode.

```bash
/opt/homebrew/bin/node "/Users/david/Documents/AFK Geoff/packages/cli/bin/afk.js" init --runner-profile smoke
```

3. Commit the AFK smoke config so the isolated AFK worktree can see it.

```bash
git add .afk/config.yaml .afk/smoke-runner.mjs
git commit -m "configure afk smoke runner"
```

4. Create `brief.md` if one does not exist.

```markdown
# AFK Execution Brief

## Requirement

Prove this repo can be driven through AFK Geoff locally without agent API keys.

## Work Item Title

Run AFK local smoke worker

## Work Item Body

Run the generated smoke runner through AFK. Do not make source changes.

## Acceptance Criteria

- AFK doctor passes
- AFK run completes successfully
- AFK produces structured JSON output
- No API key is required
```

5. Run doctor.

```bash
/opt/homebrew/bin/node "/Users/david/Documents/AFK Geoff/packages/cli/bin/afk.js" doctor --json
```

6. Run the smoke brief in detached mode.

```bash
/opt/homebrew/bin/node "/Users/david/Documents/AFK Geoff/packages/cli/bin/afk.js" run file brief.md --detach --json
```

Capture the `runId` from the final `run_result` JSON line.

7. Watch the detached run to a terminal state.

```bash
/opt/homebrew/bin/node "/Users/david/Documents/AFK Geoff/packages/cli/bin/afk.js" watch <runId> --json
```

8. Inspect AFK results.

```bash
/opt/homebrew/bin/node "/Users/david/Documents/AFK Geoff/packages/cli/bin/afk.js" inspect <runId> --json
```

## Report

Report:

- whether `doctor --json` returned `ok: true`
- whether `run file brief.md --detach --json` returned `ok: true`
- whether `watch <runId> --json` returned `ok: true`
- the `runId`
- the `workItemId`
- the branch name
- the generated `worktreePath`
- the publishability verdict from `inspect --json`
- the review verdict and verification status from `inspect --json`
- the final-result path from `inspect --json`
- any failure message
- whether the repo ended with uncommitted changes

## Do Not

- Do not use API keys.
- Do not attempt GitHub Actions.
- Do not run `--pr`.
- Do not switch to `codex` profile until smoke mode passes.
- Do not revert unrelated user changes.

## If Smoke Passes

Assess whether this repo could run a real local Codex worker next:

```bash
which codex
codex --help
```

Then report whether local Codex auth appears usable from the shell where AFK runs.
