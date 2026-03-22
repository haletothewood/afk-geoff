import type { Requirement, WorkItem } from "@afk-geoff/core";

function formatList(values: string[]): string {
  if (values.length === 0) {
    return "- None";
  }

  return values.map((value) => `- ${value}`).join("\n");
}

export function buildPlanPrompt(input: {
  requirement: Requirement;
  outputPath: string;
  overrideText?: string;
}): string {
  const override = input.overrideText ? `\n# Additional project instructions\n${input.overrideText}\n` : "";

  return `You are decomposing a software requirement into implementation work items.

Write a JSON file to this exact path:
${input.outputPath}

The JSON must match this shape:
{
  "summary": "string",
  "items": [
    {
      "key": "short-stable-key",
      "title": "work item title",
      "body": "detailed implementation brief",
      "type": "afk | hitl",
      "acceptanceCriteria": ["string"],
      "dependsOnKeys": ["other-key"]
    }
  ]
}

Rules:
- Use "afk" only for work that can be performed autonomously.
- Use "hitl" for ambiguous product or UX decisions.
- Keep tasks small and dependency-aware.
- Use dependsOnKeys only for tasks created in this same plan.
- Output nothing except the JSON file creation side effect.

# Requirement
ID: ${input.requirement.id}
Title: ${input.requirement.title}
Body:
${input.requirement.body}
${override}`;
}

export function buildWorkerPrompt(input: {
  requirement: Requirement;
  workItem: WorkItem;
  verification: string[];
  progressPath: string;
  resultPath: string;
  issueUrl?: string;
  overrideText?: string;
}): string {
  const override = input.overrideText ? `\n# Additional project instructions\n${input.overrideText}\n` : "";
  const issue = input.issueUrl ? `\nGitHub issue: ${input.issueUrl}\n` : "\n";

  return `You are executing exactly one work item in a git worktree.

Write progress updates to this exact path while the run is active:
${input.progressPath}

Write a JSON file to this exact path when you are done:
${input.resultPath}

The progress JSON must match this schema:
{
  "phase": "short current phase",
  "message": "short current activity summary",
  "iteration": 1,
  "updatedAt": "ISO timestamp"
}

The JSON must match this schema:
{
  "status": "done | blocked | failed",
  "summary": "short outcome summary",
  "issueComment": "comment to post back to the mirrored issue",
  "pr": {
    "title": "optional PR title",
    "body": "optional PR body focused on what changed",
    "manualQa": ["optional manual QA step"]
  }
}

Rules:
- Work only on the assigned item.
- Use git normally inside this worktree.
- Create a commit if you changed repo files.
- Overwrite the progress file when you start, when you move to a new major phase, and before long-running verification.
- Keep the progress fields truthful; use concise operator-facing phase and message values.
- Run verification commands before marking status "done".
- Use "blocked" only if a real dependency or ambiguity prevented completion.
- If you include PR data, keep "pr.body" focused on what changed and put reviewer steps in "pr.manualQa".
- The output file must be valid JSON. Escape any double quotes inside string values as \\".
- Prefer plain prose without embedded double quotes inside JSON strings; use single quotes in prose when that is simpler.
- Do not print the JSON; write it to the file path above.

# Requirement
${input.requirement.title}

${input.requirement.body}

# Work item
ID: ${input.workItem.id}
Title: ${input.workItem.title}
Type: ${input.workItem.type}

Body:
${input.workItem.body}

Acceptance criteria:
${formatList(input.workItem.acceptanceCriteria)}
${issue}
Verification commands:
${formatList(input.verification)}
${override}`;
}

export function buildSelfReviewPrompt(input: {
  requirement: Requirement;
  workItem: WorkItem;
  gitDiff: string;
  verificationSummary: string;
  resultPath: string;
  overrideText?: string;
}): string {
  const override = input.overrideText ? `\n# Additional project instructions\n${input.overrideText}\n` : "";

  return `You are reviewing the implementation of a work item.

Write your structured review result to this exact path:
${input.resultPath}

The JSON must match this schema:
{
  "result": "PASS" | "ISSUES",
  "issues": ["concrete issue 1", "concrete issue 2"]
}

Notes on the schema:
- Use "PASS" if all acceptance criteria are met and verification passed.
- Use "ISSUES" with a concrete, actionable list of issues if anything is missing or broken.
- The "issues" field is only required when result is "ISSUES".
- Do not print the JSON; write it to the file path above.
- Base your review only on the information provided here.

# Requirement
${input.requirement.title}

${input.requirement.body}

# Work Item
ID: ${input.workItem.id}
Title: ${input.workItem.title}

${input.workItem.body}

# Acceptance Criteria
${formatList(input.workItem.acceptanceCriteria)}

# Verification Results
${input.verificationSummary}

# Git Diff
${input.gitDiff || "No changes detected."}
${override}`;
}

export function buildFixPrompt(input: {
  requirement: Requirement;
  workItem: WorkItem;
  issues: string[];
  verification: string[];
  progressPath: string;
  resultPath: string;
  overrideText?: string;
}): string {
  const override = input.overrideText ? `\n# Additional project instructions\n${input.overrideText}\n` : "";

  return `You are fixing issues found during review of a work item implementation.

Write progress updates to this exact path while the run is active:
${input.progressPath}

Write a JSON file to this exact path when you are done:
${input.resultPath}

The progress JSON must match this schema:
{
  "phase": "short current phase",
  "message": "short current activity summary",
  "iteration": 1,
  "updatedAt": "ISO timestamp"
}

The JSON must match this schema:
{
  "status": "done | blocked | failed",
  "summary": "short outcome summary",
  "issueComment": "comment to post back to the mirrored issue"
}

Rules:
- Fix all identified issues listed below.
- Use git normally inside this worktree.
- Create a commit if you changed repo files.
- Overwrite the progress file when you start, when you move to a new major phase, and before long-running verification.
- Run verification commands before marking status "done".
- Use "blocked" only if a real dependency or ambiguity prevented completion.
- The output file must be valid JSON. Escape any double quotes inside string values as \\".
- Prefer plain prose without embedded double quotes inside JSON strings; use single quotes in prose when that is simpler.
- Do not print the JSON; write it to the file path above.

# Work Item
ID: ${input.workItem.id}
Title: ${input.workItem.title}

${input.workItem.body}

# Issues to Fix
${formatList(input.issues)}

# Verification Commands
${formatList(input.verification)}
${override}`;
}

export function buildReviewBrief(input: {
  requirement: Requirement;
  workItem: WorkItem;
  dependencyTitles: string[];
  overrideText?: string;
}): string {
  const override = input.overrideText ? `\n## Additional project instructions\n${input.overrideText}\n` : "";

  return `# HITL Review Brief

## Requirement

${input.requirement.title}

${input.requirement.body}

## Work Item

- ID: ${input.workItem.id}
- Title: ${input.workItem.title}
- Type: ${input.workItem.type}

${input.workItem.body}

## Acceptance Criteria

${formatList(input.workItem.acceptanceCriteria)}

## Dependencies

${formatList(input.dependencyTitles)}

## Review Goal

Clarify the human-in-the-loop decisions required for this item, then either:

1. update the issue/work item with the clarified decision, or
2. create a follow-up implementation-ready note for AFK execution.
${override}`;
}
