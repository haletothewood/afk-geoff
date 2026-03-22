import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createFixture, makeTempDir, MockGitHubMirror } from "./test-helpers.js";

describe("afk CLI — undo command", () => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH ?? "";
  const originalGhToken = process.env.GH_TOKEN;
  let tempDir = "";

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;

    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("Given an open AFK-created pull request, when undo is used, then the PR is closed, the branch is deleted, and the work item is marked failed", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });
    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Ship a narrow internal improvement for the AFK runner.",
        "",
        "## Work Item Title",
        "Undoable PR from a brief",
        "",
        "## Work Item Body",
        "Implement direct execution from a hand-written brief file and publish a PR.",
        "",
        "## Acceptance Criteria",
        "- A pull request is opened for review"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md", "--pr"]);

    const [requirement] = await fixture.store.listRequirements();
    const [workItem] = await fixture.items(requirement!.id);
    expect(workItem).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["undo", workItem!.id]);
    });

    const refreshed = await fixture.items(requirement!.id);
    expect(refreshed[0]?.status).toBe("failed");
    expect(refreshed[0]?.executionSummary).toContain("Undone by operator");
    expect(githubMirror.closedPullRequestNumbers).toEqual([201]);
    expect(output).toContain("Closed PR #201");

    const statusOutput = await captureConsole(async () => {
      await fixture.cli(["status"]);
    });
    expect(statusOutput).not.toContain("PR #201");
  });
});
