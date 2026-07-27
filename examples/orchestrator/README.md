# AFK Orchestrator Example

This example shows how another process can use AFK Geoff as a backend worker.

It deliberately uses only the public CLI contract:

1. `afk doctor --json`
2. `afk run file <brief> --detach --json`
3. `afk watch <runId> --json`
4. `afk inspect <runId> --json`

Run it from any AFK-configured target repository:

```bash
node /path/to/afk-geoff/examples/orchestrator/run-detached.mjs \
  --afk /path/to/afk-geoff/packages/cli/bin/afk.js \
  --cwd /path/to/target-repo \
  --brief brief.md
```

Add `--pr` when the orchestrator should require AFK to publish a pull request as the handoff boundary:

```bash
node /path/to/afk-geoff/examples/orchestrator/run-detached.mjs \
  --afk /path/to/afk-geoff/packages/cli/bin/afk.js \
  --cwd /path/to/target-repo \
  --brief brief.md \
  --pr
```

For a credential-free local smoke test in a target repo:

```bash
node /path/to/afk-geoff/packages/cli/bin/afk.js init --runner-profile smoke
git add .afk/config.yaml .afk/smoke-runner.mjs
git commit -m "configure afk smoke runner"
node /path/to/afk-geoff/examples/orchestrator/run-detached.mjs \
  --afk /path/to/afk-geoff/packages/cli/bin/afk.js \
  --brief brief.md
```

Real orchestrators can replace the console logging with Slack updates, Linear comments, CI annotations, or scheduler state transitions.
