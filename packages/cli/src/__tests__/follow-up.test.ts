import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createFixture, makeTempDir, MockGitHubMirror } from "./test-helpers.js";

describe("afk CLI — PR follow-up command", () => {
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

  it("Given an AFK-created pull request with review comments, when follow-up runs, then fixes are pushed to the existing branch", async () => {
    const githubMirror = new MockGitHubMirror();
    githubMirror.reviewComments = [
      {
        id: "comment_1",
        path: "src/app.ts",
        line: 12,
        body: "Please add error handling."
      }
    ];
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });

    fs.writeFileSync(
      `${fixture.repoDir}/brief.md`,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Ship a narrow internal improvement for the AFK runner.",
        "",
        "## Work Item Title",
        "Publish a PR",
        "",
        "## Work Item Body",
        "Create a branch and pull request.",
        "",
        "## Acceptance Criteria",
        "- A pull request is opened for review"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md", "--pr"]);
    const [initialRun] = await fixture.store.listRuns();
    expect(initialRun?.branchName).toBeDefined();
    expect(githubMirror.pullRequestRequests).toHaveLength(1);

    const output = await captureConsole(async () => {
      await fixture.cli(["follow-up", initialRun!.workItemId]);
    });

    const runs = await fixture.store.listRuns();
    const followUpRun = runs[0];
    expect(followUpRun?.branchName).toBe(initialRun!.branchName);
    expect(followUpRun?.status).toBe("completed");
    expect(githubMirror.pullRequestRequests).toHaveLength(1);
    expect(output).toContain("Addressed 1 review comment(s)");
    expect(output).toContain("- comment_1 src/app.ts:12");
    expect(output).toContain("Pushed follow-up");
  });

  it("Given an AFK-created pull request has no review comments, when follow-up runs, then it fails before starting a run", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });

    fs.writeFileSync(
      `${fixture.repoDir}/brief.md`,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Ship a narrow internal improvement for the AFK runner.",
        "",
        "## Work Item Title",
        "Publish a PR",
        "",
        "## Work Item Body",
        "Create a branch and pull request.",
        "",
        "## Acceptance Criteria",
        "- A pull request is opened for review"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md", "--pr"]);
    const [initialRun] = await fixture.store.listRuns();

    await expect(fixture.cli(["follow-up", initialRun!.workItemId])).rejects.toThrow("no actionable review comments");
    expect(await fixture.store.listRuns()).toHaveLength(1);
  });
});
