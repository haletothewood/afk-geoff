# Watcher timestamp fix and Codex baseline rerun

On 26 October 2026, a fresh installation of the locally patched AFK v0.2.0 build completed the Codex baseline in **86.761 seconds**, with **one uninterrupted watcher invocation and zero interventions after kickoff**. Verification, review, and all 17 independent acceptance checks passed. The resulting branch contains one commit and has a clean worktree.

This is a local patched build, not a published npm release. The original published-package findings remain in [the initial baseline](../2026-10-26-v0.2.0/README.md).

## Fix and regression coverage

The watcher previously forwarded worker-written ISO timestamps directly into lifecycle events. The public event schema accepts UTC `Z` timestamps, while Python's `datetime.isoformat()` can produce a valid `+00:00` offset. Event validation then terminated observation even though execution continued.

Both `progress_observed` and `heartbeat_stale` now convert the worker timestamp to canonical UTC using `Date.toISOString()` before emission. The worker artifact remains untouched, and the event schema remains unchanged. Timestamps are represented at JavaScript millisecond precision.

Three regression cases exercise the actual `watch --json` command with UTC, positive, and negative offsets and six fractional digits. Each case checks progress emission, stale-heartbeat emission, schema validity, and a successful terminal result. All three failed before the fix and pass after it. Existing UTC watcher coverage also passes.

Validation:

- Watch command suite: **9 tests passed**.
- Full suite after build: **296 tests passed across 31 files**.
- Typecheck and build: passed.
- Freshly packed CLI: installed and executed successfully in a new temporary repository.

An initial full-suite invocation started before the build existed and failed one compiled-bin initialization test with a missing bundle. After building, the complete suite passed; no unrelated test or source changes were required.

## Live rerun

The fixture, task, verification command, Node 24.14.1 runtime, Codex 0.164.0 installation, and default `gpt-6.1-sol` model matched the first baseline. The brief added one explicit instruction to write progress timestamps using `+00:00`, deliberately exercising the captured failure. The task remained label whitespace normalization, with no dependencies or GitHub publishing.

The harness started one watcher immediately after detached kickoff. A passive sampler retained changing progress artifacts without modifying them. It did not restart the watcher, edit files, send worker guidance, or retry execution.

Observed timestamp conversion:

| Worker artifact | Watcher event |
| --- | --- |
| `2026-10-26T17:40:26.188729+00:00` | `2026-10-26T17:40:26.188Z` |

All nine emitted lifecycle events pass the public schema. The watcher exited 0 with a successful completed `watch_result` and empty stderr. Final handoff confirms:

| Field | Value |
| --- | --- |
| Run ID | `run_c93bc8c97d064a2f83752b7df1f21f3f` |
| Work item ID | `wi_0582518f70e347c6bd58555c4529e38a` |
| Branch | `afk/normalize-whitespace-inside-labels-1793036417944` |
| Status | Completed |
| Review | PASS |
| Verification | Passed |
| Publishable | True |
| Recommended action | Publish |
| Commits | 1 |
| Worktree | Clean |
| Independent acceptance checks | 17 passed |
| Post-kickoff interventions | 0 |

No pull request was published. Publishability is AFK's readiness verdict.

## Evidence and reproduction

`summary.json`, `handoff.stdout`, `inspect.stdout`, and `final-result.json` retain the final verdict and original artifact paths. `watch.stdout` and `raw-progress.ndjson` retain the emitted events and raw offset timestamps. `diff.stdout` preserves the generated implementation. `regression-red.log`, `checks.txt`, and `watcher.patch` retain the regression and validation evidence. `package.json` identifies the local tarball by digest, separating it from the published v0.2.0 package.

`rerun.py` and `validate-rerun.mjs` record the harness and result assertions. They contain the original absolute paths and depend on the first baseline's fixture and isolated CLI installation; use a new empty temporary location when repeating. Original repositories and complete runner logs remain under `/private/tmp/afk-watcher-rerun-2026-10-26/`. The copied evidence here remains usable if those temporary files are removed.

This confirms the observed timestamp bug is fixed for this run. It does not establish a general unattended success rate, comparative speed, or Claude compatibility; Claude authentication remains a separate baseline blocker.
