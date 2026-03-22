import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { captureConsole, createFixture, makeTempDir } from "./test-helpers.js";

describe("self-review cycle", () => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH ?? "";
  let tempDir = "";

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("PASS path: review says PASS, fix phase is skipped, run completes", async () => {
    const fixture = await createFixture(tempDir, { reviewOutcome: "PASS" });
    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Add a feature with no issues.",
        "",
        "## Work Item Title",
        "Implement feature A",
        "",
        "## Work Item Body",
        "Build the feature.",
        "",
        "## Acceptance Criteria",
        "- Feature A exists"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md"]);
    });

    const [requirement] = await fixture.store.listRequirements();
    const [workItem] = await fixture.items(requirement!.id);
    expect(workItem?.status).toBe("done");

    // review-result.json should exist with PASS
    const [run] = await fixture.store.listRuns();
    const reviewResultPath = path.join(run!.runDir, "review-result.json");
    expect(fs.existsSync(reviewResultPath)).toBe(true);
    const reviewResult = JSON.parse(fs.readFileSync(reviewResultPath, "utf8"));
    expect(reviewResult.result).toBe("PASS");

    // fix-prompt.md should NOT exist (no fix phase)
    const fixPromptPath = path.join(run!.runDir, "fix-prompt.md");
    expect(fs.existsSync(fixPromptPath)).toBe(false);

    // review-prompt.md should exist
    const reviewPromptPath = path.join(run!.runDir, "review-prompt.md");
    expect(fs.existsSync(reviewPromptPath)).toBe(true);

    // review prompt should contain the requirement body and acceptance criteria
    const reviewPrompt = fs.readFileSync(reviewPromptPath, "utf8");
    expect(reviewPrompt).toContain("You are reviewing the implementation of a work item.");
    expect(reviewPrompt).toContain("Add a feature with no issues.");
    expect(reviewPrompt).toContain("Feature A exists");
    expect(reviewPrompt).toContain("Verification Results");
    expect(reviewPrompt).toContain("Git Diff");

    // phase logs
    expect(output).toContain("[afk] work phase");
    expect(output).toContain("[afk] review phase");
    expect(output).not.toContain("[afk] fix phase");
  });

  it("ISSUES path: review says ISSUES, fix phase runs, run completes", async () => {
    const fixture = await createFixture(tempDir, {
      reviewOutcome: "ISSUES",
      reviewIssues: ["Missing error handling in feature A", "Test coverage incomplete"]
    });
    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Add a feature that needs fixing.",
        "",
        "## Work Item Title",
        "Implement feature B",
        "",
        "## Work Item Body",
        "Build the feature.",
        "",
        "## Acceptance Criteria",
        "- Feature B exists"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md"]);
    });

    const [requirement] = await fixture.store.listRequirements();
    const [workItem] = await fixture.items(requirement!.id);
    expect(workItem?.status).toBe("done");

    const [run] = await fixture.store.listRuns();

    // review-result.json should exist with ISSUES
    const reviewResultPath = path.join(run!.runDir, "review-result.json");
    expect(fs.existsSync(reviewResultPath)).toBe(true);
    const reviewResult = JSON.parse(fs.readFileSync(reviewResultPath, "utf8"));
    expect(reviewResult.result).toBe("ISSUES");

    // fix-prompt.md should exist
    const fixPromptPath = path.join(run!.runDir, "fix-prompt.md");
    expect(fs.existsSync(fixPromptPath)).toBe(true);

    // fix prompt should contain the issues
    const fixPrompt = fs.readFileSync(fixPromptPath, "utf8");
    expect(fixPrompt).toContain("You are fixing issues found during review of a work item implementation.");
    expect(fixPrompt).toContain("Missing error handling in feature A");
    expect(fixPrompt).toContain("Test coverage incomplete");

    // phase logs
    expect(output).toContain("[afk] work phase");
    expect(output).toContain("[afk] review phase");
    expect(output).toContain("[afk] fix phase");
    expect(output).toContain("[afk] verify phase (post-fix)");
  });

  it("review prompt includes requirement, acceptance criteria, git diff, and verification results", async () => {
    const fixture = await createFixture(tempDir, { reviewOutcome: "PASS" });
    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Build a queue-based notification system.",
        "",
        "## Work Item Title",
        "Add notification queue",
        "",
        "## Work Item Body",
        "Implement the queue infrastructure.",
        "",
        "## Acceptance Criteria",
        "- Queue stores notifications",
        "- Queue supports retry logic"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md"]);

    const [run] = await fixture.store.listRuns();
    const reviewPromptPath = path.join(run!.runDir, "review-prompt.md");
    const reviewPrompt = fs.readFileSync(reviewPromptPath, "utf8");

    // Must include requirement body
    expect(reviewPrompt).toContain("Build a queue-based notification system.");
    // Must include acceptance criteria
    expect(reviewPrompt).toContain("Queue stores notifications");
    expect(reviewPrompt).toContain("Queue supports retry logic");
    // Must include verification results section
    expect(reviewPrompt).toContain("# Verification Results");
    // Must include git diff section
    expect(reviewPrompt).toContain("# Git Diff");
    // Must NOT include "You are executing exactly one work item" (worker prompt preamble)
    expect(reviewPrompt).not.toContain("You are executing exactly one work item");
  });

  it("model selection: work phase uses runner.model, review phase uses runner.review.model", async () => {
    const fixture = await createFixture(tempDir, { reviewOutcome: "PASS" });

    // Patch config to set model fields
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    config.runner.model = "claude-sonnet-4-6";
    config.runner.review = { model: "claude-opus-4-6" };
    fs.writeFileSync(configPath, YAML.stringify(config));

    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Add configurable models.",
        "",
        "## Work Item Title",
        "Configure model selection",
        "",
        "## Work Item Body",
        "Use configured models.",
        "",
        "## Acceptance Criteria",
        "- Model is configurable"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md"]);
    });

    // work phase shows work model
    expect(output).toContain("[afk] work phase [claude, model: claude-sonnet-4-6]");
    // review phase shows review model
    expect(output).toContain("[afk] review phase [claude, model: claude-opus-4-6]");
  });

  it("model selection: review phase falls back to runner.model when no review.model set", async () => {
    const fixture = await createFixture(tempDir, { reviewOutcome: "PASS" });

    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    config.runner.model = "claude-sonnet-4-6";
    // No runner.review.model set
    fs.writeFileSync(configPath, YAML.stringify(config));

    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Add configurable models.",
        "",
        "## Work Item Title",
        "Configure model fallback",
        "",
        "## Work Item Body",
        "Use configured models.",
        "",
        "## Acceptance Criteria",
        "- Model fallback works"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md"]);
    });

    // Both work and review use the same model
    expect(output).toContain("[afk] work phase [claude, model: claude-sonnet-4-6]");
    expect(output).toContain("[afk] review phase [claude, model: claude-sonnet-4-6]");
  });

  it("verification runs after work phase and after fix phase", async () => {
    const fixture = await createFixture(tempDir, {
      reviewOutcome: "ISSUES",
      reviewIssues: ["Fix needed"]
    });

    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Verify twice.",
        "",
        "## Work Item Title",
        "Test dual verification",
        "",
        "## Work Item Body",
        "Run verification after both work and fix.",
        "",
        "## Acceptance Criteria",
        "- Verification runs twice"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md"]);
    });

    // verify phase after work
    expect(output).toContain("[afk] verify phase");
    // verify phase after fix
    expect(output).toContain("[afk] verify phase (post-fix)");
  });

  it("one run record tracks the entire work-review-fix cycle", async () => {
    const fixture = await createFixture(tempDir, {
      reviewOutcome: "ISSUES",
      reviewIssues: ["Something to fix"]
    });
    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Single run record.",
        "",
        "## Work Item Title",
        "Test single run record",
        "",
        "## Work Item Body",
        "One run for the whole cycle.",
        "",
        "## Acceptance Criteria",
        "- One run record"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md"]);

    const runs = await fixture.store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
  });
});
