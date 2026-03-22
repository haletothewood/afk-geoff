import { describe, expect, it } from "vitest";
import { buildSelfReviewPrompt, buildFixPrompt } from "./prompts.js";
import type { Requirement, WorkItem } from "@afk-geoff/core";

const testRequirement: Requirement = {
  id: "req_test",
  title: "Add feature X",
  body: "Feature X improves the system.",
  status: "approved",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const testWorkItem: WorkItem = {
  id: "wi_test",
  requirementId: "req_test",
  title: "Implement feature X",
  body: "Create the implementation.",
  type: "afk",
  status: "in_progress",
  planKey: "feature-x",
  executionSummary: "Implementing feature X",
  acceptanceCriteria: ["Feature X is present", "Tests pass"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("buildSelfReviewPrompt", () => {
  it("includes the distinctive preamble for fake runner detection", () => {
    const prompt = buildSelfReviewPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      gitDiff: "diff --git a/src/x.ts...",
      verificationSummary: "[PASSED] pnpm typecheck",
      resultPath: "/afk-run/review-result.json"
    });

    expect(prompt).toContain("You are reviewing the implementation of a work item.");
  });

  it("includes the result path", () => {
    const prompt = buildSelfReviewPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      gitDiff: "",
      verificationSummary: "No verification commands configured.",
      resultPath: "/afk-run/review-result.json"
    });

    expect(prompt).toContain("/afk-run/review-result.json");
  });

  it("includes requirement body and acceptance criteria", () => {
    const prompt = buildSelfReviewPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      gitDiff: "diff --git a/x.ts...",
      verificationSummary: "[PASSED] pnpm typecheck",
      resultPath: "/afk-run/review-result.json"
    });

    expect(prompt).toContain("Feature X improves the system.");
    expect(prompt).toContain("Feature X is present");
    expect(prompt).toContain("Tests pass");
  });

  it("includes verification results and git diff sections", () => {
    const prompt = buildSelfReviewPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      gitDiff: "diff --git a/x.ts...",
      verificationSummary: "[PASSED] pnpm typecheck",
      resultPath: "/afk-run/review-result.json"
    });

    expect(prompt).toContain("# Verification Results");
    expect(prompt).toContain("[PASSED] pnpm typecheck");
    expect(prompt).toContain("# Git Diff");
    expect(prompt).toContain("diff --git a/x.ts...");
  });

  it("shows 'No changes detected.' when git diff is empty", () => {
    const prompt = buildSelfReviewPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      gitDiff: "",
      verificationSummary: "No verification commands configured.",
      resultPath: "/afk-run/review-result.json"
    });

    expect(prompt).toContain("No changes detected.");
  });

  it("does not include worker preamble", () => {
    const prompt = buildSelfReviewPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      gitDiff: "",
      verificationSummary: "",
      resultPath: "/afk-run/review-result.json"
    });

    expect(prompt).not.toContain("You are executing exactly one work item");
  });

  it("includes override text when provided", () => {
    const prompt = buildSelfReviewPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      gitDiff: "",
      verificationSummary: "",
      resultPath: "/afk-run/review-result.json",
      overrideText: "# Custom review instructions"
    });

    expect(prompt).toContain("# Custom review instructions");
  });
});

describe("buildFixPrompt", () => {
  it("includes the distinctive preamble for fake runner detection", () => {
    const prompt = buildFixPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      issues: ["Missing tests", "Broken import"],
      verification: ["pnpm typecheck"],
      progressPath: "/afk-run/fix-progress.json",
      resultPath: "/afk-run/fix-result.json"
    });

    expect(prompt).toContain("You are fixing issues found during review of a work item implementation.");
  });

  it("includes all issues to fix", () => {
    const prompt = buildFixPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      issues: ["Missing tests", "Broken import"],
      verification: ["pnpm typecheck"],
      progressPath: "/afk-run/fix-progress.json",
      resultPath: "/afk-run/fix-result.json"
    });

    expect(prompt).toContain("Missing tests");
    expect(prompt).toContain("Broken import");
  });

  it("includes verification commands", () => {
    const prompt = buildFixPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      issues: ["Bug"],
      verification: ["pnpm typecheck", "pnpm test"],
      progressPath: "/afk-run/fix-progress.json",
      resultPath: "/afk-run/fix-result.json"
    });

    expect(prompt).toContain("pnpm typecheck");
    expect(prompt).toContain("pnpm test");
  });

  it("includes result and progress paths", () => {
    const prompt = buildFixPrompt({
      requirement: testRequirement,
      workItem: testWorkItem,
      issues: ["Bug"],
      verification: [],
      progressPath: "/afk-run/fix-progress.json",
      resultPath: "/afk-run/fix-result.json"
    });

    expect(prompt).toContain("/afk-run/fix-result.json");
    expect(prompt).toContain("/afk-run/fix-progress.json");
  });
});
