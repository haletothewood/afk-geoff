# AFK Geoff v0.2.0 fresh install baseline

On 26 October 2026, the published AFK v0.2.0 package completed a small implementation and review through current stable Codex without coding assistance. The observation path required intervention. Current Claude could not authenticate, so its implementation quality remains untested.

This is a compatibility and supervision baseline on one macOS host, using disposable repositories. It is not evidence of production reliability, broad task success rate, or an advantage over direct agent use.

## Environment and installation

- AFK: npm `afk-geoff@0.2.0`, freshly installed outside this checkout. No source build or AFK patches.
- Node: 24.14.1, ABI 137. npm: 11.11.0.
- Current stable versions returned by npm: Codex 0.164.0 and Claude Code 2.1.310. Both were installed separately under the temporary baseline directory.
- Existing installations were Codex 0.163.0-alpha.10.2 and Claude Code 2.1.233; neither was upgraded in place.
- Codex resolved its existing default to `gpt-6.1-sol`, low reasoning, for both implementation and review. No model override.
- AFK backend: `local-process`. Generated profiles retained their default runner invocations. GitHub integration was disabled, with no remote, PR publication, push, or merge.
- Fixture Git identity was local to each temporary repository; commit signing was disabled there.
- Installation logs, npm lockfiles, configuration, briefs, command output, and authoritative completion artifacts are retained alongside this report. No credentials or authentication stores were copied.

The host also has Homebrew Node 25.9.0. One executable launch used ABI 141 against the native SQLite addon installed for ABI 137. Pinning AFK to the exact Node 24 executable resolved the error without rebuilding or modifying AFK. The baseline does not establish why that invocation selected the competing runtime.

## Task and procedure

Each profile used its own initialized Git repository. The real-agent repositories started with the same dependency-free JavaScript function and one passing test. The task was to retain trimming and lowercasing, collapse internal JavaScript whitespace to ASCII spaces, handle empty input, reject non-strings with TypeError, add tests, and commit a clean change.

The smoke profile was an orchestration control instructed to make no source changes. Its no-diff result was expected; it does not validate the requested label behavior.

1. Install the published package into an empty temporary directory.
2. Initialize AFK with each generated runner profile.
3. Configure `node --test` as project verification and commit fixture/configuration/brief.
4. Run `doctor --json`; all three profiles returned `ok: true`.
5. Start `afk run file brief.md --detach --json`.
6. Capture `watch`, `inspect`, `handoff`, and `final-result.json`.
7. Independently evaluate Codex's produced implementation with 17 external assertions and rerun its four tests. The external assertions were not supplied to the worker or reviewer.

AFK was invoked with `/Users/david/.nvm/versions/node/v24.14.1/bin/node` after the runtime mismatch. Current CLIs were selected by prepending the isolated tools directory to PATH. Source fixtures, the acceptance checker, and setup/start/observation scripts are retained here. Scripts contain original absolute temporary paths and require a new empty test location before reuse; they are a record of this execution rather than an idempotent test suite.

## Results

Elapsed times below use AFK's persisted run creation and terminal update timestamps. They exclude installation, fixture preparation, and operator diagnosis.

| Profile | Elapsed | Authoritative outcome | Review and verification | Supervision |
| --- | ---: | --- | --- | --- |
| Smoke | 0.671 s | Completed, non-publishable because no diff | PASS; verification passed | Shared Node runtime correction before successful kickoff |
| Codex 0.164.0 | 56.927 s | Completed, publishable; one commit; clean worktree | PASS; verification passed; 17 independent assertions passed | No coding edits or retry; watcher diagnosis and terminal observation retry |
| Claude Code 2.1.310 | 0.705 s | Failed, non-publishable; clean worktree | No review; verification skipped | Authentication diagnosis; unresolved |

Codex changed only `label.js` and `label.test.js`. Four tests pass, and the independently checked cases include tabs/newlines, Unicode whitespace, empty strings, punctuation, zero-width space preservation, and non-string values. The implementation and review reported 9,334 and 12,697 tokens respectively (22,031 total reported by the CLI); these counters do not establish billable usage or monetary cost.

## Failures and limitations observed

### Native dependency runtime mismatch

The first smoke kickoff failed before a run was created because `better-sqlite3` was built for ABI 137 and invoked under ABI 141. The preceding `doctor` had passed. AFK returned structured failure JSON with the native-module message. The correction was to pin Node 24. Subsequent smoke and real-agent runs used that binary.

**Implication:** preflight does not establish that the state database can load under the effective execution runtime. A host with several Node installations adds setup friction.

Evidence: `smoke/kickoff.stdout`, `smoke/kickoff.stderr`, and `smoke/kickoff-pinned.stdout`.

### Watch rejects a valid timestamp offset

Codex wrote an agent progress timestamp using Python's ISO format with a `+00:00` offset. During active execution, `watch --json` exited 1 with `Invalid ISO datetime` at `progressUpdatedAt`; the reported schema requires a `Z` suffix. The worker prompt asked for an ISO timestamp without restricting it to that suffix.

Execution continued through verification and review. Initial handoff/inspect reported a running run. Repeating watch after completion succeeded, and final handoff reported `publishable: true`, `recommendedAction: publish`, one commit, passing review and verification, and a clean worktree. No progress file was edited and no implementation rerun was needed.

**Implication:** a correctly continuing worker can break the caller's observation loop. A caller needs an observation fallback or retry. Normalize accepted timestamps or consistently document and enforce the required form before emission.

Evidence: `codex/watch.stdout`, `codex/watch-terminal.stdout`, `codex/handoff.json`, and `codex/final-result.json`.

### Claude authentication fails after successful preflight

The generated Claude profile uses `--print --bare --permission-mode bypassPermissions`. The worker exited 1 with `Not logged in · Please run /login`. No worker result was produced. AFK saved a failed, non-publishable final result and watch exited nonzero.

A separate current-CLI `auth status` probe reported `loggedIn: true` with `authMethod: api_key`; an actual direct `--print` request without `--bare` nevertheless failed with the same login message. Thus neither AFK's executable check nor the CLI's status report established usable authentication. The no-bare probe does not support blaming this failure solely on AFK's bare mode. No keys were provisioned or authentication settings changed.

AFK's terminal message was `No result.json found (exit code 1, iteration 1)`, categorized as an orchestrator failure. The actionable login error remained in the worker log rather than the handoff. Its evidence packet also said no verification commands were configured, although project and brief both configured `node --test`; those commands were skipped because the worker failed.

**Implication:** improve authenticated readiness checks and preserve runner failure causes in the structured handoff. Distinguish configured-but-skipped verification from absent verification. Claude completion must be rerun after usable authentication is established.

Evidence: `claude/doctor.stdout`, `claude/work-stdout-1.log`, `claude/auth-probe.stdout`, and `claude/final-result.json`.

## Supervision accounting

No human clarification, login, approval response, code edit, or review correction was needed during this agent-operated baseline. The Codex implementation needed zero coding interventions and no extra worker iteration.

There were three operator diagnostic episodes:

1. Shared setup: investigate the native-addon mismatch and pin the runtime.
2. Codex observation: inspect the watcher failure and query the terminal result again.
3. Claude startup: inspect worker logs and test authentication outside AFK; the blocker remains unresolved.

This is not a zero-supervision result. Human active minutes were not measured, and agent diagnostic time cannot be presented as a measured human labour saving. Claude still needs a usable authentication setup before it can complete the same baseline.

## Run identities and retained evidence

| Profile | Run ID | Work item ID |
| --- | --- | --- |
| Smoke | `run_9b4d646d10a6482b9a1bd4a1fd33cb05` | `wi_63a98a724b6c4a4eb38027976c3dfb04` |
| Codex | `run_f84cc97e3c7943579b98b0b120370625` | `wi_80572b153bc64c51a0012257ff84aed3` |
| Claude | `run_31ea69ba243f42dead72283afe211159` | `wi_72a2ca932a154309bdebbcf4e3782b9d` |

Branch names, worktree paths, source artifact paths, and terminal verdicts are in `summary.json` and each profile's `handoff.json`. The original repositories and complete runner logs remain under `/private/tmp/afk-baseline-2026-10-26/`; these are temporary. The copied evidence here persists independently, although its original absolute path fields still point to that temporary location. `codex/diff.stdout` preserves the resulting change.

## Recommended next work

1. Fix and regression-test the watcher timestamp mismatch. It affected an otherwise successful current-agent run.
2. Establish usable Claude authentication and repeat the unchanged task. Then improve preflight and structured startup diagnostics using the observed failure.
3. Add a database-load runtime check to preflight, and clarify runtime pinning in fresh-install instructions.
4. Proceed to larger tasks across real repositories and comparison with direct agent execution only after this compatibility baseline is clean.

PR publication, review follow-up, cancellation, interruption recovery, Docker, GitHub Actions, adversarial admission, larger repositories, and comparative cost or supervision savings were not exercised by this baseline. No AFK implementation fixes were made as part of recording these results.

## Subsequent watcher fix

The [patched-build Codex rerun](../2026-10-26-watcher-fix/README.md) completed with one uninterrupted watcher and zero post-kickoff interventions. It deliberately exercised `+00:00` worker timestamps. The original published-package results above are unchanged.

## Claude access clarification

The user subsequently confirmed that no Claude access is available. The [credential-free rerun](../2026-10-26-claude-no-access/README.md) validates expected failure handling; a successful Claude implementation baseline remains blocked by that prerequisite. The original login failure alone does not establish an AFK authentication defect.
