import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createFixture, makeTempDir, MockGitHubMirror } from "./test-helpers.js";

describe("afk CLI — run command", () => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH ?? "";
  const originalGhToken = process.env.GH_TOKEN;
  const originalBreakWorktreeGit = process.env.AFK_TEST_BREAK_WORKTREE_GIT;
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

    if (originalBreakWorktreeGit === undefined) {
      delete process.env.AFK_TEST_BREAK_WORKTREE_GIT;
    } else {
      process.env.AFK_TEST_BREAK_WORKTREE_GIT = originalBreakWorktreeGit;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("Given a failed AFK work item, when run is invoked again, then it is retried", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();
    await fixture.store.updateWorkItemStatus(backend!.id, "failed");

    await fixture.cli(["run", backend!.id]);

    const refreshed = await fixture.items(requirement.id);
    expect(refreshed.find((item) => item.id === backend!.id)?.status).toBe("done");
  });

  it("Given an execution brief file, when run file is used, then it creates tracked state and passes brief verification into the worker prompt", async () => {
    const fixture = await createFixture(tempDir);
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
        "Add file-backed execution",
        "",
        "## Work Item Body",
        "Implement direct execution from a hand-written brief file.",
        "",
        "## Acceptance Criteria",
        "- The runner can import a local brief file",
        "- The imported work item is executed and tracked locally",
        "",
        "## Verification",
        "- pnpm typecheck",
        "- pnpm test -- packages/cli/src/index.test.ts"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md"]);
    });

    const requirements = await fixture.store.listRequirements();
    expect(requirements).toHaveLength(1);

    const [requirement] = requirements;
    expect(requirement?.status).toBe("completed");

    const items = await fixture.items(requirement!.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Add file-backed execution");
    expect(items[0]?.status).toBe("done");

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const prompt = fs.readFileSync(path.join(run!.runDir, "prompt.md"), "utf8");
    expect(prompt).toContain("Write progress updates to this exact path while the run is active:");
    expect(prompt).toContain("/afk-run/progress.json");
    expect(prompt).toContain('Escape any double quotes inside string values as \\".');
    expect(prompt).toContain("- pnpm typecheck");
    expect(prompt).toContain("- pnpm test -- packages/cli/src/index.test.ts");
    expect(output).toContain("Imported execution brief");
    expect(output).toContain(`Work item ${items[0]!.id}`);
  });

  it("Given repo-level claude.md and .claude config, when a Claude run executes, then runner-home includes both", async () => {
    const fixture = await createFixture(tempDir);
    fs.writeFileSync(path.join(fixture.repoDir, "claude.md"), "# Project Claude instructions\nUse deterministic output.\n");
    fs.mkdirSync(path.join(fixture.repoDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(fixture.repoDir, ".claude", "settings.json"), JSON.stringify({ mode: "test" }, null, 2));

    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const runnerHome = path.join(run!.runDir, "runner-home");
    const copiedInstructions = path.join(runnerHome, "CLAUDE.md");
    const copiedClaudeSettings = path.join(runnerHome, ".claude", "settings.json");

    expect(fs.existsSync(copiedInstructions)).toBe(true);
    expect(fs.existsSync(copiedClaudeSettings)).toBe(true);
    expect(fs.readFileSync(copiedInstructions, "utf8")).toContain("Project Claude instructions");
    expect(JSON.parse(fs.readFileSync(copiedClaudeSettings, "utf8"))).toEqual({ mode: "test" });
  });

  it("Given the worker writes malformed JSON with unescaped quotes, when run file is used, then AFK repairs the result and completes the run", async () => {
    const fixture = await createFixture(tempDir, {
      runnerScriptSuffix: [
        "fs.writeFileSync(outputPath, `{",
        '  "status": "done",',
        '  "summary": "Recovered malformed JSON worker result",',
        '  "issueComment": "Preserve the existing "run directory missing" path unchanged",',
        '  "pr": {',
        '    "title": "AFK: complete work item",',
        '    "body": "Done"',
        "  }",
        "}`);",
        "process.exit(0);"
      ].join("\n")
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
        "Repair malformed worker result JSON",
        "",
        "## Work Item Body",
        "Recover from common LLM JSON escaping mistakes when reading result.json.",
        "",
        "## Acceptance Criteria",
        "- Malformed quoted prose in result.json does not crash the run"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md"]);

    const [requirement] = await fixture.store.listRequirements();
    const [workItem] = await fixture.items(requirement!.id);
    const [run] = await fixture.store.listRuns();

    expect(workItem?.status).toBe("done");
    expect(run?.status).toBe("completed");
    expect(run?.summary).toBe("Recovered malformed JSON worker result");
  });

  it("Given GitHub publishing is enabled, when run file is used with --pr, then it opens a pull request and prints the review URL", async () => {
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
        "Open a PR from a brief",
        "",
        "## Work Item Body",
        "Implement direct execution from a hand-written brief file and publish a PR.",
        "",
        "## Acceptance Criteria",
        "- The runner can import a local brief file",
        "- A pull request is opened for review"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md", "--pr"]);
    });

    expect(githubMirror.pullRequestRequests).toHaveLength(1);
    expect(githubMirror.pullRequestRequests[0]?.body).toContain("## What Changed");
    expect(githubMirror.pullRequestRequests[0]?.body).toContain("## Why");
    expect(githubMirror.pullRequestRequests[0]?.body).toContain("## Model Used");
    expect(githubMirror.pullRequestRequests[0]?.body).toContain("## Agent");
    expect(githubMirror.pullRequestRequests[0]?.body).toContain("This change was completed by Geoff");
    expect(output).toContain("Opened PR: https://example.com/pull_request/201");
  });

  it("Given the worker leaves the worktree on a different branch, when run file is used with --pr, then AFK still pushes the intended publication branch", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror,
      runnerScriptSuffix: [
        'const worktreeGitPath = path.join(process.cwd(), ".git");',
        'if (fs.existsSync(worktreeGitPath) && fs.lstatSync(worktreeGitPath).isFile()) {',
        '  fs.unlinkSync(worktreeGitPath);',
        '  fs.cpSync(path.join(process.cwd(), "..", "..", "..", ".git"), worktreeGitPath, { recursive: true });',
        '}',
        'execFileSync("git", ["checkout", "-B", "master"]);'
      ].join("\n")
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
        "Recover intended publication branch",
        "",
        "## Work Item Body",
        "Ensure publish still works even if the worker changes the current branch.",
        "",
        "## Acceptance Criteria",
        "- A pull request is opened for review"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md", "--pr"]);
    });

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: run!.worktreePath, encoding: "utf8" }).trim();
    const publishedSha = execFileSync("git", ["ls-remote", "origin", `refs/heads/${run!.branchName}`], { cwd: run!.worktreePath, encoding: "utf8" })
      .trim()
      .split(/\s+/)[0];

    expect(githubMirror.pullRequestRequests).toHaveLength(1);
    expect(publishedSha).toBe(headSha);
    expect(output).toContain("Opened PR: https://example.com/pull_request/201");
  });

  it("Given Docker requires real git worktree metadata, when run file is used with --pr, then AFK preserves origin and still opens the PR", async () => {
    process.env.AFK_TEST_BREAK_WORKTREE_GIT = "1";
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
        "Preserve git worktree metadata in Docker",
        "",
        "## Work Item Body",
        "Ensure the Docker runtime keeps the real git worktree and origin remote intact.",
        "",
        "## Acceptance Criteria",
        "- A pull request is opened for review"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md", "--pr"]);
    });

    expect(githubMirror.pullRequestRequests).toHaveLength(1);
    expect(output).toContain("Opened PR: https://example.com/pull_request/201");
  });

  it("Given post-run PR publishing fails, when run file is used with --pr, then the work item and run are marked failed instead of staying running", async () => {
    const githubMirror = new MockGitHubMirror();
    githubMirror.openPullRequestError = new Error("simulated PR failure");
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
        "Fail publish cleanly",
        "",
        "## Work Item Body",
        "Ensure publish failures leave AFK in a recoverable failed state.",
        "",
        "## Acceptance Criteria",
        "- The failed publish does not leave the run stuck in running"
      ].join("\n")
    );

    await expect(fixture.cli(["run", "file", "brief.md", "--pr"])).rejects.toThrow("simulated PR failure");

    const [requirement] = await fixture.store.listRequirements();
    const [workItem] = await fixture.items(requirement!.id);
    const [run] = await fixture.store.listRuns();

    expect(workItem?.status).toBe("failed");
    expect(run?.status).toBe("failed");
    expect(run?.summary).toContain("Post-run publication failed: simulated PR failure");
  });

  it("Given GH_TOKEN is unset but GitHub auth can be resolved, when run file is used with --pr, then publishing still works", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror,
      githubTokenResolver: async () => "resolved-token"
    });
    delete process.env.GH_TOKEN;
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
        "Open a PR from resolved auth",
        "",
        "## Work Item Body",
        "Use resolved GitHub auth instead of an exported GH_TOKEN.",
        "",
        "## Acceptance Criteria",
        "- A pull request is opened for review"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md", "--pr"]);
    });

    expect(githubMirror.pullRequestRequests).toHaveLength(1);
    expect(output).toContain("Opened PR: https://example.com/pull_request/201");
  });

  it("Given a GitHub issue work source, when run issue is used, then it imports the issue as an execution brief and executes it", async () => {
    const fixture = await createFixture(tempDir, {
      githubIssueWorkSource: {
        async load() {
          return {
            requirementBody: "Ship a narrow internal improvement for the AFK runner.",
            workItemTitle: "Run from issue",
            workItemBody: "Execute a hand-authored GitHub issue body.",
            acceptanceCriteria: ["The runner can import a GitHub issue body"],
            verification: ["pnpm typecheck"],
            issueUrl: "https://github.com/acme/demo/issues/42"
          };
        }
      }
    });

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "issue", "https://github.com/acme/demo/issues/42"]);
    });

    const [requirement] = await fixture.store.listRequirements();
    expect(requirement?.status).toBe("completed");
    const [workItem] = await fixture.items(requirement!.id);
    expect(workItem?.title).toBe("Run from issue");

    const [run] = await fixture.store.listRuns();
    const prompt = fs.readFileSync(path.join(run!.runDir, "prompt.md"), "utf8");
    expect(prompt).toContain("https://github.com/acme/demo/issues/42");
    expect(output).toContain("Imported execution brief https://github.com/acme/demo/issues/42");
  });

  it("Given GitHub mirroring is enabled, when actionable queue items exist, then only the requirement and actionable work items are mirrored", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      writeWorktreeChange: false,
      githubMirror
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    expect(githubMirror.requirementMirrorIds).toEqual([requirement.id]);
    expect(githubMirror.workItemMirrorIds).toEqual([]);

    let items = await fixture.seedQueue(requirement.id);
    const backend = items.find((item) => item.planKey === "backend");
    const frontend = items.find((item) => item.planKey === "frontend");
    const review = items.find((item) => item.planKey === "review");

    expect(backend?.status).toBe("todo");
    expect(frontend?.status).toBe("blocked");
    expect(review?.status).toBe("hitl_pending");
    expect(githubMirror.workItemMirrorIds).toEqual([backend!.id, review!.id]);

    await fixture.cli(["run", backend!.id]);
    await fixture.cli(["status"]);

    items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === frontend!.id)?.status).toBe("todo");
    expect(githubMirror.workItemMirrorIds).toEqual([backend!.id, review!.id, frontend!.id]);
    expect(githubMirror.pullRequestRequests).toHaveLength(0);
  });

  it("Given a foreground run, when run is used without --detach, then the foreground behavior is unchanged", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("done");
  });

  it("Given an execution brief without mode fields, when run file is used, then the worker prompt includes an inferred execution mode section", async () => {
    const fixture = await createFixture(tempDir);
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
        "Add inferred mode support",
        "",
        "## Work Item Body",
        "Ensure AFK infers the execution mode from the brief content.",
        "",
        "## Acceptance Criteria",
        "- Execution mode is inferred and present in the worker prompt"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md"]);

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const prompt = fs.readFileSync(path.join(run!.runDir, "prompt.md"), "utf8");
    expect(prompt).toContain("# Execution Mode");
    expect(prompt).toContain("**Mode:**");
    expect(prompt).toContain("**Risk Tolerance:**");
    expect(prompt).toContain("**Rationale:**");
    expect(prompt).toContain("## Posture for this mode");
  });

  it("Given an execution brief with an explicit Execution Mode, when run file is used, then the worker prompt reflects that mode", async () => {
    const fixture = await createFixture(tempDir);
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
        "Add explicit mode support",
        "",
        "## Work Item Body",
        "Ensure AFK respects an explicit execution mode from the brief.",
        "",
        "## Acceptance Criteria",
        "- Explicit execution mode is reflected in the worker prompt",
        "",
        "## Execution Mode",
        "incident-responder"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md"]);

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const prompt = fs.readFileSync(path.join(run!.runDir, "prompt.md"), "utf8");
    expect(prompt).toContain("# Execution Mode");
    expect(prompt).toContain("Incident Responder");
    expect(prompt).toContain("Restore service first");
  });

  it("Given an execution brief with Execution Mode, Overlays, and Risk, when run file is used, then the worker prompt includes all three", async () => {
    const fixture = await createFixture(tempDir);
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
        "Add full mode config support",
        "",
        "## Work Item Body",
        "Verify all execution control fields flow through to the worker prompt.",
        "",
        "## Acceptance Criteria",
        "- All execution control fields appear in the worker prompt",
        "",
        "## Execution Mode",
        "production-hardener",
        "",
        "## Overlays",
        "- security-gatekeeper",
        "",
        "## Risk",
        "low"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md"]);

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const prompt = fs.readFileSync(path.join(run!.runDir, "prompt.md"), "utf8");
    expect(prompt).toContain("Production Hardener");
    expect(prompt).toContain("Security Gatekeeper");
    expect(prompt).toContain("Low");
    expect(prompt).toContain("## Active overlays");
    expect(prompt).toContain("security review");
  });
});
