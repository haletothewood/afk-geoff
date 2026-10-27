# Running AFK

Operational reference for the current main branch. The npm release may lag main; required commit-signature policy is unreleased after v0.2.1.

## Execution Modes

Execution modes are AFK's formal operator profiles for run posture.

- `brownfield-moderniser` / `refactoring-surgeon`: craftsmanship-oriented modernization and careful structural change
- `incident-responder`: urgent production stabilization
- `debug-investigator`: bug-squashing and root-cause analysis
- `pragmatic-shipper`: delivery-first default when no stronger signal exists

Overlays (`security-gatekeeper`, `performance-tuner`, `accessibility-advocate`) add additional posture constraints without replacing the primary mode.


## Local runner profiles

The `pnpm exec afk` examples assume a repo-local installation (`pnpm add -D afk-geoff`). The target repository needs a committed base branch matching `baseBranch` (default: `main`).

Local execution is the primary workflow. Codex can use its existing session; the built-in Claude profile requires explicit credentials as described below.

Use a credential-free smoke runner first:

```bash
pnpm exec afk init --runner-profile smoke
git add .afk/config.yaml .afk/smoke-runner.mjs
git commit -m "configure afk smoke runner"
pnpm exec afk doctor
pnpm exec afk run file brief.md --json
```

The smoke profile writes `.afk/smoke-runner.mjs` and configures AFK to call it for both work and review using the `local-process` backend. It makes no repo changes and requires no API keys, so it is the safest way to test AFK as an orchestration substrate.

For a real local agent CLI:

```bash
pnpm exec afk init --runner-profile claude
pnpm exec afk doctor
pnpm exec afk run file brief.md --json
```

```bash
pnpm exec afk init --runner-profile codex
pnpm exec afk doctor
pnpm exec afk run file brief.md --json
```

Local runner profiles set `execution.backend: local-process` and `github.enabled: false`, so `doctor` can pass in a plain local repo without Docker, an `origin` remote, or a GitHub token. The Claude and Codex profiles require the `claude` or `codex` executable to exist on `PATH`. Codex can use its existing local account/session.

The built-in local Claude profile uses `--bare` and an isolated home directory. Configure `ANTHROPIC_API_KEY` or supported provider credentials; a Claude subscription login alone is not used in bare mode. `doctor` checks Claude's offline authentication status in that execution context and fails when authentication is missing or cannot be determined. A passing check means authentication is configured, not that the credentials have been validated with a model request. Custom runner commands and Docker retain their existing executable and required-environment checks.

AFK is not tied to one agent. Each repository can choose:

- `afk init --runner-profile claude` for Claude CLI
- `afk init --runner-profile codex` for Codex CLI
- `afk init --runner-profile smoke` for a deterministic no-key smoke runner
- `runner.kind: custom` with `runner.command` and optional `runner.reviewCommand` in `.afk/config.yaml` for another CLI agent that accepts AFK's prompt path

Example custom command config:

```yaml
runner:
  kind: custom
  command: ["other-agent", "run", "{prompt}"]
  reviewCommand: ["other-agent", "review", "{prompt}"]
  requiredEnv: []
  envAllowlist: ["GH_TOKEN"]
```

One repo can use Codex while another uses Claude or a custom agent. Within a repo, set `runner.reviewCommand` when you want review to use a different command from implementation.

Verification checks in `.afk/config.yaml` accept the existing string form and a structured form:

```yaml
verification:
  - pnpm typecheck
  - command: pnpm test
```

Both forms normalize to the same verification entry before execution. The structured form is the extension point for future per-check policy; only `command` is currently supported.

Turn GitHub back on in `.afk/config.yaml` when you want source issue comments or PR publishing:

```yaml
github:
  enabled: true
```

Commit signing is policy-aware and is not a universal requirement. The default `auto` mode reads the effective rules for `baseBranch` from GitHub when GitHub integration is enabled; local repositories continue to use ordinary unsigned commits. Use `enabled` to require signing even when the target branch does not, or `disabled` to force unsigned commits only where the target permits them:

```yaml
git:
  signing:
    mode: auto # auto | enabled | disabled
    # key: release@example.com # optional Git signing key selector; never a private key value
```

When signing is enforced, AFK probes the configured backend without changing branch history, signs work, fix, and follow-up commits, verifies every commit in the AFK branch range locally, and confirms GitHub's verification result after push. Missing policy access, unavailable signing, unsigned commits, or host-rejected signatures make `final-result.json` non-publishable. Structured doctor, run, inspect, and handoff output expose the effective policy and non-secret capability status.

Add `runner.requiredEnv` only when you want CI-style non-interactive credential checks.


## Safe First Workflow

Start with one work item at a time and keep the loop human-reviewed while the orchestration contract stabilizes:

1. Capture a requirement.
2. Create an execution brief with your preferred planning skill.
3. Run one AFK item with `run file` or inspect queue state with `status` and `show`.
4. Inspect artifacts with `runs` and `logs`.
5. Review the worktree and branch before merging anything.

Suggested command flow:

```bash
pnpm exec afk capture "Describe a small internal improvement"
pnpm exec afk run file brief.md --pr
pnpm exec afk status
pnpm exec afk show <requirement-id>
pnpm exec afk runs
pnpm exec afk logs <run-id>
pnpm exec afk follow-up <work-item-id>
```


## GitHub-Backed Setup

Once the repo has a GitHub remote:

1. Add an `origin` remote.
2. Export `GH_TOKEN`.
3. Ensure the configured runner auth env vars are set.
4. Run `pnpm exec afk init --with-github-actions` to install the workflow harness.
5. Run `pnpm exec afk doctor`.


## GitHub Actions Harness

The repository includes an experimental manual workflow, `AFK Run`, for external orchestrators that want a remote "issue URL in, PR out" entry point.

Install it in a target repo with:

```bash
pnpm exec afk init --with-github-actions
```

If `.afk/config.yaml` already exists, this command only adds `.github/workflows/afk-run.yml`. It refuses to overwrite an existing workflow unless `--force-github-actions` is passed.

The workflow checks the target repo out into `target/`, checks AFK Geoff out into `afk-geoff/`, installs AFK's dependencies, and invokes that checkout's CLI against the target repo. Override the AFK source at dispatch time with `--afk-repository` and `--afk-ref` when testing a branch.

When testing this checkout directly from another repo, run the compiled bin:

```bash
node /path/to/afk-geoff/packages/cli/bin/afk.js init --with-github-actions
```

Required repository secrets:

- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, depending on the configured runner auth

Dispatch inputs:

- `issue_url`: GitHub issue URL containing an AFK execution brief
- `backend`: currently `local-docker`
- `require_pr`: whether the run must publish a pull request
- `afk_repository`: AFK Geoff repository to check out for the worker CLI
- `afk_ref`: AFK Geoff branch, tag, or SHA to check out

Workflow artifacts:

- `afk-doctor.json`: structured preflight result
- `afk-result.json`: structured run result or failure payload

External orchestrators can trigger that workflow through the CLI:

```bash
pnpm exec afk submit issue <github-issue-url> --backend github-actions --json
pnpm exec afk submit issue <github-issue-url> --backend github-actions --afk-ref <branch-or-sha> --json
pnpm exec afk remote-runs --json
pnpm exec afk remote-artifacts <github-actions-run-id> --json
pnpm exec afk remote-download <github-actions-artifact-id> --json
```


## Useful Commands

- `pnpm exec afk doctor`
- `pnpm exec afk status`
- `pnpm exec afk show <id>`
- `pnpm exec afk runs`
- `pnpm exec afk logs <run-id>`
- `pnpm exec afk review <work-item-id>`
- `pnpm exec afk follow-up <work-item-id>`
- `pnpm exec afk watch <run-id>`
- `pnpm exec afk cleanup`


## Guardrails

- SQLite remains the source of truth.
- GitHub is a mirror and collaboration surface.
- HITL work is not auto-dispatched.
- `result.json` is the authoritative worker outcome.
- `final-result.json` is the authoritative completed-run and publishability artifact.
- Run artifacts are retained for debugging.

