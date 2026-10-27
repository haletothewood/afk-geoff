<p align="left">
  <img src="docs/assets/afk-geoff-wordmark.svg" alt="AFK Geoff" width="360">
</p>

# AFK Geoff

**Give your coding agent a brief. Get verified changes and a reviewable pull request.**

AFK runs Codex, Claude, or a custom CLI in an isolated Git worktree. It runs your checks, asks a reviewer to inspect the result, and sends issues through a bounded fix loop. You get the branch, logs, verification results, and a structured handoff to decide what happens next.

AFK can open and update a PR. Merging and deployment remain with you or your orchestrator.

## First run

You need Node.js 22+, pnpm, Git, and an installed, authenticated Codex CLI. Start in an existing repository with a committed `main` branch. Set `baseBranch` in `.afk/config.yaml` if your branch has another name.

```sh
pnpm add -D afk-geoff@0.2.1
pnpm exec afk init --runner-profile codex
pnpm exec afk doctor --json
```

Proceed when doctor reports `ok: true`. This profile runs locally and leaves GitHub publishing disabled. Commit the dependency changes and AFK configuration before starting work. No Docker or GitHub token is needed for this first run.

Save the following as `brief.md`. This small demonstration adds two new files and uses Node's built-in test runner; it needs no test-framework setup.

```markdown
# AFK Execution Brief

## Requirement
Normalize whitespace in display labels.

## Work Item Title
Normalize label whitespace

## Work Item Body
Add afk-label-demo.mjs at the repository root, exporting normalizeLabel.
For strings, trim leading and trailing whitespace and collapse runs of
whitespace to one space. Return non-string inputs unchanged. Add tests in
afk-label-demo.test.mjs using node:test and node:assert/strict.
Keep these demo files separate from application code.

## Acceptance Criteria
- Leading and trailing whitespace is removed.
- Internal spaces, tabs and newlines collapse to one space.
- Non-string inputs are returned unchanged.
- Tests cover spaces, tabs, newlines, empty strings and non-string inputs.

## Verification
- node --test afk-label-demo.test.mjs
```

For real work, replace this demonstration with a focused project task and checks that demonstrate its acceptance criteria. Ensure the two demo filenames are unused before trying the example.

```sh
pnpm exec afk run file brief.md --detach --json
```

Use the `runId` from the final output line:

```sh
pnpm exec afk watch <run-id> --json
pnpm exec afk handoff <run-id> --json
```

A successful handoff has `publishable: true`, review `PASS`, verification passed, and a clean worktree. Inspect the diff and evidence before merging. A completed process alone does not establish success; `final-result.json` is the authoritative result.

## What AFK checks

- **Isolation:** work happens on a separate branch and worktree.
- **Verification:** project and brief commands must pass; choose checks that establish the requested outcome.
- **Review:** a separate reviewer invocation inspects the result; it can use the same agent as implementation or a different configured runner.
- **Repository state:** publication readiness requires a committed diff and clean worktree.
- **Evidence:** `.afk/runs/` retains progress, logs, review and verification results, and failure details.

The review is another model invocation, not a guarantee of correctness. Local workers execute commands on your machine; a worktree isolates Git changes, not operating-system access. Use trusted repositories and review generated changes.

## Open a pull request

Configure a GitHub `origin` remote and provide `GH_TOKEN` with the repository access needed for publishing. Enable integration in `.afk/config.yaml`:

```yaml
github:
  enabled: true
```

Commit the configuration, rerun doctor, then add `--pr` to your run:

```sh
pnpm exec afk doctor --json
pnpm exec afk run file brief.md --detach --pr --json
```

To address review feedback on the same PR branch, use the work-item ID from the run:

```sh
pnpm exec afk follow-up <work-item-id> --json
```

## Runners and current limits

Codex uses its existing local session. The built-in Claude profile uses `--bare` and an isolated home: configure `ANTHROPIC_API_KEY` or supported provider credentials; subscription login alone is not used. Its doctor check establishes configured authentication, not successful provider access. Custom commands manage their own authentication.

AFK preserves the Node installation that launched it across local work, review, and verification. Start it with the Node version used to install native dependencies. Docker workers use their image's runtime.

AFK is early-stage software. Local execution is the primary path; GitHub Actions execution is experimental. Detached-run ownership, cancellation, and recovery remain active roadmap work. The recorded Codex fixture completed without intervention after the watcher fix; a successful live Claude baseline remains unvalidated because Claude access was unavailable.

## Version status

The first-run instructions target published **v0.2.1**, which includes watcher timestamp, Claude authentication diagnostics, PR-retry, and Node-runtime fixes.

**Unreleased on main:** required commit-signature policy discovers target requirements, checks configured signing capability, and gates publication on local and GitHub verification across execution and recovery. This is not included in npm v0.2.1. See the [signing configuration](docs/running-afk.md#local-runner-profiles) for the source-build behavior.

## Documentation

- [Runner profiles, signing, execution modes and GitHub Actions](docs/running-afk.md)
- [Agent orchestrator quick start](docs/agent-orchestrator-quickstart.md)
- [Machine-readable protocol and evidence](docs/orchestrator-contract.md)
- [Parent-process integration example](examples/orchestrator)
- [Roadmap](docs/roadmap.md)
- [Build and release guide](docs/development.md)

## License status

This repository does not currently declare a license. No open-source license grant is stated here.
