# AFK Execution Brief

## Requirement
Normalize internal whitespace in labels without changing existing trim and lowercase behavior.

## Work Item Title
Normalize whitespace inside labels

## Work Item Body
Exercise the smoke runner only; make no source changes. Do not implement the label behavior. Ignore implementation instructions below for this smoke control. Collapse each run of JavaScript whitespace (spaces, tabs, newlines) to one ASCII space, after trimming and lowercasing. Empty or whitespace-only strings return an empty string. Non-string inputs must throw TypeError. Add behavior tests. Use no dependencies. Commit the change. Do not modify AFK configuration or this brief. Do not publish or contact GitHub.

## Acceptance Criteria
- Leading and trailing whitespace is removed and letters are lowercased.
- Internal whitespace runs become one ASCII space, including tabs and newlines.
- Empty and whitespace-only input returns an empty string.
- Non-string inputs throw TypeError.
- Tests pass and changes are committed with a clean worktree.

## Verification
- node --test
