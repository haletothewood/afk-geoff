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
  const originalStatusInterval = process.env.AFK_STATUS_INTERVAL_MS;
  const originalDetachRunId = process.env.AFK_DETACH_RUN_ID;
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

    if (originalStatusInterval === undefined) {
      delete process.env.AFK_STATUS_INTERVAL_MS;
    } else {
      process.env.AFK_STATUS_INTERVAL_MS = originalStatusInterval;
    }

    if (originalDetachRunId === undefined) {
      delete process.env.AFK_DETACH_RUN_ID;
    } else {
      process.env.AFK_DETACH_RUN_ID = originalDetachRunId;
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
        "- node -e \"process.exit(0)\"",
        "- node -e \"console.log('brief verification')\""
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
    expect(prompt).toContain('- node -e "process.exit(0)"');
    expect(prompt).toContain('- node -e "console.log(\'brief verification\')"');
    expect(output).toContain("Imported execution brief");
    expect(output).toContain(`Work item ${items[0]!.id}`);
  });

  it("Given an ambiguous verification alternative, when run file is used, then it is rejected before tracked state or a worker run is created", async () => {
    const fixture = await createFixture(tempDir);
    fs.writeFileSync(
      path.join(fixture.repoDir, "brief.md"),
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
        "",
        "## Verification",
        "- `npm install` or `pnpm install`"
      ].join("\n")
    );

    await expect(fixture.cli(["run", "file", "brief.md"])).rejects.toThrow(
      "Verification command must be one explicit shell command"
    );

    expect(await fixture.store.listRequirements()).toEqual([]);
    expect(await fixture.store.listRuns()).toEqual([]);
  });

  it("Given conflicting package-manager lockfiles, when run is requested, then admission rejects it before creating a run", async () => {
    const fixture = await createFixture(tempDir);
    fs.writeFileSync(path.join(fixture.repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(fixture.repoDir, "package-lock.json"), "{}\n");

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow(
      /Package manager conflict: .*secondary lockfiles/
    );

    expect(await fixture.store.listRuns()).toEqual([]);
    expect((await fixture.items(requirement.id)).find((item) => item.id === backend!.id)?.status).toBe("todo");
  });

  it("Given the smoke runner profile, when run file is used, then it completes without agent credentials", async () => {
    const fixture = await createFixture(tempDir, { writeWorktreeChange: false });
    await fixture.cli(["init", "--runner-profile", "smoke"]);
    execFileSync("git", ["add", ".afk/config.yaml", ".afk/smoke-runner.mjs"], { cwd: fixture.repoDir });
    execFileSync("git", ["commit", "-m", "configure afk smoke runner"], { cwd: fixture.repoDir });

    fs.writeFileSync(
      path.join(fixture.repoDir, "brief.md"),
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Prove AFK orchestration without a live agent.",
        "",
        "## Work Item Title",
        "Run no-key smoke worker",
        "",
        "## Work Item Body",
        "Complete without touching repository files.",
        "",
        "## Acceptance Criteria",
        "- The run completes",
        "- The smoke runner does not require API credentials"
      ].join("\n")
    );

    await fixture.cli(["run", "file", "brief.md", "--json"]);

    const [run] = await fixture.store.listRuns();
    expect(run?.status).toBe("completed");
    expect(run?.summary).toBe("Smoke runner completed without making changes");
    expect(fs.readFileSync(path.join(run!.runDir, "result.json"), "utf8")).toContain("AFK smoke runner completed successfully");
    expect(fs.existsSync(path.join(run!.runDir, "work-result-1.json"))).toBe(true);
    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      latestWorkerSummary: string;
      workerResults: Array<{ phase: string; summary: string }>;
      reviewResults: Array<{ verdict: string }>;
    };
    expect(finalResult.latestWorkerSummary).toBe("Smoke runner completed without making changes");
    expect(finalResult.workerResults).toEqual([
      expect.objectContaining({ phase: "work", summary: "Smoke runner completed without making changes" })
    ]);
    expect(finalResult.reviewResults).toEqual([
      expect.objectContaining({ verdict: "PASS" })
    ]);
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

  it("Given a detached parent pre-created run metadata, when the worker resumes, then it keeps the same branch", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runId = "run_precreated_detached_branch";
    const branchName = "afk/precreated-detached-branch";
    const runDir = path.join(fixture.repoDir, ".afk", "runs", runId);
    const worktreePath = path.join(fixture.repoDir, ".afk", "worktrees", runId);
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.createRun({
      id: runId,
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName,
      worktreePath,
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    process.env.AFK_DETACH_RUN_ID = runId;

    await fixture.cli(["run", backend!.id]);

    const run = (await fixture.store.listRuns()).find((candidate) => candidate.id === runId);
    expect(run?.status).toBe("completed");
    expect(run?.branchName).toBe(branchName);
    const finalResult = JSON.parse(fs.readFileSync(path.join(runDir, "final-result.json"), "utf8")) as { branchName: string };
    expect(finalResult.branchName).toBe(branchName);
    const actualBranch = execFileSync("git", ["branch", "--show-current"], { cwd: worktreePath, encoding: "utf8" }).trim();
    expect(actualBranch).toBe(branchName);
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

  it("Given a quiet worker, when run is active, then AFK prints still-running status ticks", async () => {
    process.env.AFK_STATUS_INTERVAL_MS = "1";
    const fixture = await createFixture(tempDir, {
      runnerScriptSuffix: "await new Promise((resolve) => setTimeout(resolve, 50));"
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["run", backend!.id]);
    });

    expect(output).toContain("[work] iteration 1: still running");
    expect(output).toContain("logs: work-stdout-1.log, work-stderr-1.log");
  });

  it("Given TypeScript build info churn, when AFK commits, then generated artifacts are cleaned and reported", async () => {
    const fixture = await createFixture(tempDir, {
      runnerScriptSuffix: [
        'fs.writeFileSync(path.join(process.cwd(), "tsconfig.tsbuildinfo"), "cache\\n");',
        'fs.writeFileSync(path.join(process.cwd(), "pnpm-workspace.yaml"), "allowBuilds:\\n  esbuild: set this to true or false\\n");'
      ].join("\n")
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["run", backend!.id]);
    });

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const status = execFileSync("git", ["status", "--short"], { cwd: run!.worktreePath, encoding: "utf8" });
    const diffNames = execFileSync("git", ["diff", "--name-only", "main..HEAD"], { cwd: run!.worktreePath, encoding: "utf8" });
    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      generatedArtifacts: Array<{ stage: string; paths: string[] }>;
      worktreeStatus: { clean: boolean; shortStatus: string };
    };

    expect(status).not.toContain("tsconfig.tsbuildinfo");
    expect(status).not.toContain("pnpm-workspace.yaml");
    expect(diffNames).not.toContain("tsconfig.tsbuildinfo");
    expect(diffNames).not.toContain("pnpm-workspace.yaml");
    expect(finalResult.worktreeStatus.clean).toBe(true);
    expect(finalResult.generatedArtifacts).toHaveLength(1);
    expect(finalResult.generatedArtifacts[0]).toEqual(expect.objectContaining({ stage: "post-worker" }));
    expect(finalResult.generatedArtifacts[0]?.paths).toEqual(
      expect.arrayContaining(["tsconfig.tsbuildinfo", "pnpm-workspace.yaml"])
    );
    expect(output).toContain("[cleanup] post-worker: removed generated artifacts");
    expect(output).toContain("tsconfig.tsbuildinfo");
    expect(output).toContain("pnpm-workspace.yaml");
  });

  it("Given the worker creates a commit, when AFK records the run, then final result counts that commit", async () => {
    const fixture = await createFixture(tempDir, {
      writeWorktreeChange: false,
      runnerScriptSuffix: [
        'fs.writeFileSync(path.join(process.cwd(), "worker-owned.txt"), "done\\n");',
        'execFileSync("git", ["add", "worker-owned.txt"], { cwd: process.cwd() });',
        'execFileSync("git", ["commit", "-m", "Worker owned change"], { cwd: process.cwd() });'
      ].join("\n")
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["run", backend!.id]);
    });

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      commits: Array<{ created: boolean; sha?: string; source?: string }>;
      summary: string;
    };
    const workerCommit = finalResult.commits.find((commit) => commit.source === "worker");

    expect(workerCommit).toEqual(expect.objectContaining({ created: true, source: "worker" }));
    expect(workerCommit?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(finalResult.summary).toContain("1 commit");
    expect(output).toContain("[commit] iteration 1: worker commit");
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

  it("Given post-run PR publishing fails, when the failed work item is retried, then reviewed evidence is reused for publishing", async () => {
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

    const promptPath = path.join(run!.runDir, "prompt.md");
    const promptModifiedAt = fs.statSync(promptPath).mtimeMs;
    githubMirror.openPullRequestError = undefined;

    await fixture.cli(["run", workItem!.id, "--pr"]);

    const [retriedRun] = await fixture.store.listRuns();
    const [retriedWorkItem] = await fixture.items(requirement!.id);
    const finalResult = JSON.parse(fs.readFileSync(path.join(retriedRun!.runDir, "final-result.json"), "utf8")) as {
      recovery: {
        reusedStages: string[];
        retriedStages: string[];
      };
      evidencePacket: {
        recovery: {
          reusedStages: string[];
          retriedStages: string[];
        };
      };
      workerResults: Array<{ phase: string }>;
    };

    expect(await fixture.store.listRuns()).toHaveLength(1);
    expect(retriedWorkItem?.status).toBe("done");
    expect(retriedRun?.status).toBe("completed");
    expect(githubMirror.pullRequestRequests).toHaveLength(1);
    expect(fs.statSync(promptPath).mtimeMs).toBe(promptModifiedAt);
    expect(finalResult.workerResults).toHaveLength(1);
    expect(finalResult.recovery).toEqual(
      expect.objectContaining({
        reusedStages: ["work", "verification", "review"],
        retriedStages: ["publishing"]
      })
    );
    expect(finalResult.evidencePacket.recovery).toEqual(finalResult.recovery);
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
            verification: [{ command: "node -e \"process.exit(0)\"" }],
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

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md"]);
    });

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const prompt = fs.readFileSync(path.join(run!.runDir, "prompt.md"), "utf8");
    expect(output).toContain("Mode resolution:");
    expect(output).toContain("(inferred)");
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

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md"]);
    });

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    const prompt = fs.readFileSync(path.join(run!.runDir, "prompt.md"), "utf8");
    expect(output).toContain("Mode resolution:");
    expect(output).toContain("Incident Responder (explicit)");
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
