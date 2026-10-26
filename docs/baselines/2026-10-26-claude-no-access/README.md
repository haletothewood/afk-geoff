# Claude baseline without account access

On 26 October 2026, the user confirmed that no Claude access is available. The earlier login failure is therefore an expected missing prerequisite; it does not establish an AFK authentication defect. A successful Claude implementation and review baseline remains blocked.

A fresh credential-free rerun with Claude Code 2.1.310 and the AFK build merged as `fba4ba4` confirmed failure handling. Both a direct Claude invocation with AFK's exact default flags and the AFK worker returned `Not logged in · Please run /login`.

## Validation performed

The same dependency-free label-normalization fixture and original Claude brief were used in a new temporary Git repository. AFK was freshly installed from the local patched v0.2.0 tarball used for the successful watcher rerun; its source matches the merged watcher fix. This was not a new npm release. Node 24.14.1 was pinned.

Credential and provider environment variables were removed from the test subprocess, and `CLAUDE_CONFIG_DIR` pointed to an empty temporary directory. No credentials were inspected, copied, provisioned, or added. Existing account configuration was unchanged.

| Check | Observed result |
| --- | --- |
| Direct CLI with `--print --bare --permission-mode bypassPermissions` | Exit 1; not logged in |
| AFK doctor | `ok: true`; checks executable presence, not authenticated access |
| Detached kickoff | Success; a tracked run was created |
| Single watcher | Exit 1 with a structured failed terminal result |
| Final artifact | Persisted, failed, non-publishable |
| Worktree and commits | Independently confirmed clean; zero commits against main |
| Verification and review | Skipped; no worker result was produced |
| Recorded run duration | 0.622 seconds |
| Post-kickoff interventions | Zero; terminal failure was automatic |

The 17 implementation acceptance assertions were not run: there was no implementation to evaluate. This validates the unavailable-access path rather than Claude's coding capability.

## Diagnosis and remaining integration questions

The absent access is sufficient to explain the observed login failure. AFK still has two diagnostic shortcomings: doctor passes without proving authenticated readiness, and the structured handoff reports only `No result.json found (exit code 1, iteration 1)` rather than preserving the underlying login message. Neither was changed during this investigation.

Source inspection also found that AFK overrides Claude's `HOME` to a run-specific directory and invokes `--bare`. Current Claude documentation states that bare mode does not read subscription OAuth credentials or the system keychain; it requires an appropriate explicit credential source. These defaults need a separate compatibility test if subscription-backed execution is later required. Removing `--bare` alone would not resolve a lack of account access. See [Claude programmatic execution](https://code.claude.com/docs/en/headless) and [authentication](https://code.claude.com/docs/en/authentication).

## Required intervention

One prerequisite remains unmet: supply usable Claude access through a supported credential source before attempting a successful implementation baseline. No account, subscription, API key, cloud configuration, or login was created, and no such action is assumed or requested by this report. Human active time and authentication setup effort are unknown, rather than zero.

If access becomes available, validate it with a successful real request first, then repeat the unchanged fixture with a single watcher. Require passing worker verification, independent review, a committed diff, a clean worktree, and all 17 external acceptance assertions before declaring the implementation baseline successful.

## Evidence

Run: `run_eed7b00f81e245d794d81dd83c5b47d3`.
Work item: `wi_031bc2ec37e9417d9c0608dead65d1a5`.
Branch: `afk/normalize-whitespace-inside-labels-1793039259992`.

`summary.json`, `handoff.stdout`, `inspect.stdout`, and `final-result.json` preserve identity, verdicts, and original artifact paths. `direct-probe.stdout` and `work-stdout-1.log` preserve the actual login messages. `measurements.json` records command durations and exit codes. `rerun.py` records the fixture and credential-free procedure using original absolute paths; use a new empty temporary directory when repeating.

Original temporary files remain under `/private/tmp/afk-claude-no-access-2026-10-26/`; copied evidence here persists independently. No AFK implementation changes were made.

## Subsequent authentication diagnostics fix

The local patch now makes `doctor --json` exit 1 with `ok: false` and a `runner auth` failure in this same credential-free fixture. `doctor-fixed.stdout` retains the updated result. The check uses `claude --bare auth status --json` in an isolated home, with an eight-second timeout, and makes no model request. Missing credentials and unrecognized or failed status responses are failures; configured authentication is explicitly distinguished from validated credentials. Custom commands and Docker retain their prior checks.

The patch also persists recognized Claude login errors from worker stdout/stderr and reviewer logs into the authoritative terminal failure, which handoff exposes. Eight account-free regression cases cover missing and configured authentication, malformed/failed status, both worker streams, and reviewer login failure. All 304 tests, typecheck, and build pass. The real no-access case remains correctly non-publishable.
