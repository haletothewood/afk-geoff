import type { Requirement, WorkItem } from "@afk-geoff/core";
import type { ResolvedExecutionMode } from "./execution-mode.js";
import type { VerificationFailureCategory } from "./failure.js";
import { formatExecutionModeSection } from "./execution-mode.js";

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
  executionMode?: ResolvedExecutionMode;
}): string {
  const override = input.overrideText ? `\n# Additional project instructions\n${input.overrideText}\n` : "";
  const modeSection = input.executionMode ? `\n${formatExecutionModeSection(input.executionMode)}\n` : "";

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
${modeSection}
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
  executionMode?: ResolvedExecutionMode;
  createCommit?: boolean;
}): string {
  const override = input.overrideText ? `\n# Additional project instructions\n${input.overrideText}\n` : "";
  const issue = input.issueUrl ? `\nGitHub issue: ${input.issueUrl}\n` : "\n";
  const modeSection = input.executionMode ? `\n${formatExecutionModeSection(input.executionMode)}\n` : "";
  const commitRule = input.createCommit === false
    ? "- Do not create commits. Leave repository changes for the AFK host to commit with its configured signing capability."
    : "- Create a commit if you changed repo files.";

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
${commitRule}
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
${modeSection}${override}`;
}

export interface VerificationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  failureCategory?: VerificationFailureCategory;
}

export function buildAutonomousReviewPrompt(input: {
  requirement: Requirement;
  workItem: WorkItem;
  gitDiff: string;
  verificationResults: VerificationCommandResult[];
  resultPath: string;
  overrideText?: string;
}): string {
  const override = input.overrideText ? `\n# Additional project instructions\n${input.overrideText}\n` : "";

  const verificationSection =
    input.verificationResults.length === 0
      ? "No verification commands were run."
      : input.verificationResults
          .map((r) => {
            const status = r.passed ? "PASSED" : `FAILED: ${r.failureCategory ?? "product"}`;
            const lines = [`## ${r.command} [${status}]`];
            if (r.stdout.trim()) {
              lines.push("stdout:", r.stdout.trim());
            }
            if (r.stderr.trim()) {
              lines.push("stderr:", r.stderr.trim());
            }
            return lines.join("\n");
          })
          .join("\n\n");

  return `You are performing an autonomous code review for an AI-generated implementation.

Write your review verdict JSON to this exact path:
${input.resultPath}

The verdict JSON must match this schema:
{
  "verdict": "PASS | ISSUES | BLOCKED",
  "issues": ["concrete, actionable defect or risk (only for ISSUES)"],
  "blockerReason": "reason blocking completion (only for BLOCKED)"
}

Verdict meanings:
- PASS: acceptance criteria are met and no material unresolved code issues or unacceptable risk remain.
- ISSUES: concrete, actionable defects or risks remain; the agent must fix them.
- BLOCKED: ambiguity, dependency, or missing information prevents safe completion.

Rules:
- Output ONLY the JSON file. Do not explain or summarise outside the JSON.
- PASS only if ALL acceptance criteria are fully met and verification passed.
- If verification failed and the failures are fixable code issues, return ISSUES with each failure as an issue.
- If verification failed due to infrastructure (missing tools, environment), return BLOCKED with the reason.
- Missing or malformed prior output is a reason for ISSUES, not PASS.
- Be concrete and actionable: each issue must describe exactly what to fix.
- Do not print the JSON; write it to the file path above.

# Requirement
${input.requirement.title}

${input.requirement.body}

# Acceptance Criteria
${formatList(input.workItem.acceptanceCriteria)}

# Verification Results
${verificationSection}

# Git Diff (changes since base branch)
\`\`\`diff
${input.gitDiff}
\`\`\`
${override}`;
}

export function buildFixWorkerPrompt(input: {
  requirement: Requirement;
  workItem: WorkItem;
  verification: string[];
  progressPath: string;
  resultPath: string;
  reviewIssues: string[];
  issueUrl?: string;
  overrideText?: string;
  createCommit?: boolean;
}): string {
  const override = input.overrideText ? `\n# Additional project instructions\n${input.overrideText}\n` : "";
  const issue = input.issueUrl ? `\nGitHub issue: ${input.issueUrl}\n` : "\n";
  const commitRule = input.createCommit === false
    ? "- Do not create commits. Leave repository changes for the AFK host to commit with its configured signing capability."
    : "- Create a commit if you changed repo files.";

  return `You are fixing issues identified by an autonomous review in a git worktree.

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
- Fix ONLY the issues listed below. Do not make unrelated changes.
- Use git normally inside this worktree.
${commitRule}
- Overwrite the progress file when you start, when you move to a new major phase, and before long-running verification.
- Run verification commands before marking status "done".
- Use "blocked" only if the issues cannot be fixed due to a real dependency or ambiguity.
- If you include PR data, keep "pr.body" focused on what changed and put reviewer steps in "pr.manualQa".
- The output file must be valid JSON. Escape any double quotes inside string values as \\".
- Prefer plain prose without embedded double quotes inside JSON strings; use single quotes in prose when that is simpler.
- Do not print the JSON; write it to the file path above.

# Original requirement
${input.requirement.title}

${input.requirement.body}

# Work item
ID: ${input.workItem.id}
Title: ${input.workItem.title}

# Issues to fix
${formatList(input.reviewIssues)}
${issue}
Verification commands:
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
