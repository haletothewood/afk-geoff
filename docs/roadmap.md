# AFK Geoff Roadmap

AFK Geoff is becoming a boringly reliable execution and evidence layer for agentic repository work.
Humans and higher-level orchestrators choose and approve the work; AFK owns the isolated implementation,
verification, review, recovery, and structured handoff loop.

## Now

- finish and freeze the pull-request follow-up and machine-readable orchestration contracts
- harden detached-run lifecycle, worktree ownership, cancellation, deadlines, and recovery
- improve work admission so underspecified, unsafe, or unverifiable work is narrowed or blocked before execution
- strengthen execution-policy and accountability evidence without weakening the human change-request boundary

## Next

- expose verified runner and backend capabilities through structured preflight
- support enforceable independent-review policies while retaining deterministic verification as the primary evidence
- deepen the common local-process and local-container workspace lifecycle
- add project-aware evidence profiles and application verification artifacts
- measure end-to-end cost, duration, retry causes, and contribution effectiveness
- harden the optional GitHub Actions execution path

## Later

- add source, publishing, and isolated execution adapters where demonstrated demand justifies them
- support operational alert and vulnerability inputs through constrained, evidence-rich briefs
- improve comprehension-debt reporting and human-approved learning from completed work
- propose proactive maintenance and reuse opportunities without granting automatic mutation authority

## Product Boundaries

- AFK remains implementation-independent and owns its domain model, runtime lifecycle, evidence, and public contracts.
- External agent frameworks may inform research but are not runtime dependencies or compatibility targets.
- Pull requests and equivalent change requests remain the default handoff boundary; AFK does not silently merge or deploy.
- Identity, repository protection, production authority, and final business decisions remain with accountable humans and external systems.

Roadmap order may change as the execution contract is tested in real repositories.
