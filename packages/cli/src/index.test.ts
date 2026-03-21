import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { ChangeRequest, ChangeRequestPublisher, ExternalRef, IssueMirror, Requirement, WorkItem, WorkSource } from "@afk-geoff/core";
import { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";
import { runCli } from "./index.js";

interface FixtureOptions {
  githubEnabled?: boolean;
  writeWorktreeChange?: boolean;
  githubMirror?: MockGitHubMirror;
  githubIssueWorkSource?: WorkSource<string>;
  githubTokenResolver?: () => Promise<string | undefined>;
}

interface WorkflowFixture {
  repoDir: string;
  store: SqliteStateStore;
  githubMirror: MockGitHubMirror | undefined;
  cli(args: string[]): Promise<void>;
  capture(prompt: string): Promise<Requirement>;
  requirement(): Promise<Requirement>;
  items(requirementId: string): Promise<Awaited<ReturnType<SqliteStateStore["listWorkItemsByRequirement"]>>>;
  seedQueue(requirementId: string): Promise<Awaited<ReturnType<SqliteStateStore["listWorkItemsByRequirement"]>>>;
}

describe("afk CLI BDD scenarios", () => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH ?? "";
  const originalGhToken = process.env.GH_TOKEN;
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-"));
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

  it("Given a captured requirement with no execution brief yet, when status is used, then it points to external planning plus run file", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["status"]);
    });

    expect(output).toContain(`- ${requirement.id}`);
    expect(output).toContain("Use a planning skill to produce an execution brief");
    expect(output).toContain("pnpm afk run file <path>");
  });

  it("Given a captured requirement with no work items, when show is used, then it points to external planning plus run file", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["show", requirement.id]);
    });

    expect(output).toContain(`Requirement ${requirement.id}`);
    expect(output).toContain("Next");
    expect(output).toContain("Use a planning skill to create an execution brief");
  });

  it("Given pending work exists, when status is used, then it prints the next actionable command", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    const items = await fixture.seedQueue(requirement.id);
    const backend = items.find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["status"]);
    });

    expect(output).toContain("Runnable AFK items");
    expect(output).toContain(backend!.id);
    expect(output).toContain("Next");
    expect(output).toContain(`pnpm afk run ${backend!.id}`);
  });

  it("Given local workflow prerequisites are present, when doctor runs, then it reports success", async () => {
    const fixture = await createFixture(tempDir);

    const output = await captureConsole(async () => {
      await fixture.cli(["doctor"]);
    });

    expect(output).toContain("OK git: git");
    expect(output).toContain("OK docker: docker");
    expect(output).toContain("OK runner: node");
    expect(output).toContain("Doctor checks passed");
  });

  it("Given runner env vars are missing, when doctor runs, then it reports all missing requirements before failing", async () => {
    const fixture = await createFixture(tempDir);
    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerRequiredEnv: ["OPENAI_API_KEY", "SECOND_REQUIRED_ENV"]
    });
    delete process.env.OPENAI_API_KEY;
    delete process.env.SECOND_REQUIRED_ENV;

    const output = await captureConsole(async () => {
      await expect(fixture.cli(["doctor"])).rejects.toThrow("Doctor checks failed (2 issues)");
    });

    expect(output).toContain("FAIL env:OPENAI_API_KEY: Missing required env var OPENAI_API_KEY");
    expect(output).toContain("FAIL env:SECOND_REQUIRED_ENV: Missing required env var SECOND_REQUIRED_ENV");
  });

  it("Given a blocked AFK work item, when its dependency completes and status is refreshed, then it becomes todo", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    await fixture.cli(["dispatch", "--max", "1"]);

    let items = await fixture.items(requirement.id);
    expect(items.find((item) => item.planKey === "backend")?.status).toBe("done");

    await fixture.cli(["status"]);
    items = await fixture.items(requirement.id);
    expect(items.find((item) => item.planKey === "frontend")?.status).toBe("todo");
  });

  it("Given dependent AFK work exists, when dispatch runs with the default loop, then it keeps executing until the queue is drained or the loop limit is hit", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const output = await captureConsole(async () => {
      await fixture.cli(["dispatch"]);
    });

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.planKey === "backend")?.status).toBe("done");
    expect(items.find((item) => item.planKey === "frontend")?.status).toBe("done");
    expect(items.find((item) => item.planKey === "review")?.status).toBe("hitl_pending");
    expect(output).toContain("Dispatch iteration 1/10");
    expect(output).toContain("Dispatch iteration 2/10");
    expect(output).toContain("Dispatch complete after 2 iteration(s): queue drained");
  });

  it("Given an active run with a progress file, when status is used, then it shows live progress details for that run", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_active");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    await fixture.store.createRun({
      id: "run_active",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/active",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_active"),
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(
      path.join(runDir, "progress.json"),
      JSON.stringify({ phase: "running", message: "Implementing changes", iteration: 3, updatedAt: "2026-03-21T12:00:00.000Z" }, null, 2)
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["status"]);
    });

    expect(output).toContain("run_active");
    expect(output).toContain("[running]");
    expect(output).toContain("Implementing changes");
    expect(output).toContain("iteration 3");
  });

  it("Given an active run with a progress file, when show is used for the work item, then it includes progress details", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_show_active");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    await fixture.store.createRun({
      id: "run_show_active",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/show-active",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_show_active"),
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(
      path.join(runDir, "progress.json"),
      JSON.stringify({ phase: "running", message: "Writing tests", iteration: 7, updatedAt: "2026-03-21T12:00:00.000Z" }, null, 2)
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["show", backend!.id]);
    });

    expect(output).toContain("Active run: run_show_active");
    expect(output).toContain("[running]");
    expect(output).toContain("Writing tests");
    expect(output).toContain("iteration 7");
  });

  it("Given a stale running work item with a missing run directory, when status is refreshed, then the run and work item are marked failed", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    await fixture.store.createRun({
      id: "run_stale",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/stale",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_stale"),
      runDir: path.join(fixture.repoDir, ".afk", "runs", "run_stale"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await fixture.cli(["status"]);

    const refreshed = await fixture.items(requirement.id);
    expect(refreshed.find((item) => item.id === backend!.id)?.status).toBe("failed");
    const staleRun = (await fixture.store.listRuns()).find((run) => run.id === "run_stale");
    expect(staleRun?.status).toBe("failed");
    expect(staleRun?.summary).toContain("Run directory missing");
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
    expect(prompt).toContain("- pnpm typecheck");
    expect(prompt).toContain("- pnpm test -- packages/cli/src/index.test.ts");
    expect(output).toContain("Imported execution brief");
    expect(output).toContain(`Work item ${items[0]!.id}`);
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

  it("Given a HITL work item, when review is prepared, then a review run and review brief are created", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    const seededItems = await fixture.seedQueue(requirement.id);
    const reviewItem = seededItems.find((item) => item.planKey === "review");

    expect(reviewItem).toBeDefined();
    await fixture.cli(["review", reviewItem!.id]);

    const runs = await fixture.store.listRuns();
    const reviewRun = runs.find((run) => run.mode === "review");
    expect(reviewRun).toBeDefined();
    expect(fs.existsSync(path.join(reviewRun!.runDir, "review.md"))).toBe(true);

    const reviewBrief = fs.readFileSync(path.join(reviewRun!.runDir, "review.md"), "utf8");
    expect(reviewBrief).toContain("## Requirement");
    expect(reviewBrief).toContain("Review UX copy");
    expect(reviewBrief).toContain("## Acceptance Criteria");
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

  it("Given requirements and runs exist, when inspection commands are used, then they show actionable local debugging information", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    await fixture.cli(["dispatch", "--max", "1"]);

    const items = await fixture.items(requirement.id);
    const backend = items.find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const showRequirementOutput = await captureConsole(async () => {
      await fixture.cli(["show", requirement.id]);
    });
    expect(showRequirementOutput).toContain(`Requirement ${requirement.id}`);
    expect(showRequirementOutput).toContain("Work items");

    const showWorkItemOutput = await captureConsole(async () => {
      await fixture.cli(["show", backend!.id]);
    });
    expect(showWorkItemOutput).toContain(`Work item ${backend!.id}`);
    expect(showWorkItemOutput).toContain("Acceptance criteria");

    const [workRun] = await fixture.store.listRuns();
    expect(workRun).toBeDefined();

    const runsOutput = await captureConsole(async () => {
      await fixture.cli(["runs"]);
    });
    expect(runsOutput).toContain("Runs");
    expect(runsOutput).toContain(workRun!.id);

    const logsOutput = await captureConsole(async () => {
      await fixture.cli(["logs", workRun!.id]);
    });
    expect(logsOutput).toContain(`Run ${workRun!.id}`);
    expect(logsOutput).toContain("== result:");
    expect(logsOutput).toContain('"status": "done"');
  });
});

async function createFixture(tempDir: string, options: FixtureOptions = {}): Promise<WorkflowFixture> {
  const repoDir = path.join(tempDir, "repo");
  const fakeBinDir = path.join(tempDir, "bin");
  const remoteDir = path.join(tempDir, "remote.git");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });

  writeFakeDocker(fakeBinDir);
  writeRepoFiles(repoDir, options.writeWorktreeChange ?? true);
  process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;

  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

  if (options.githubEnabled) {
    execFileSync("git", ["init", "--bare", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
  }

  process.chdir(repoDir);

  const dependencies = options.githubMirror
    || options.githubIssueWorkSource
    ? {
        ...(options.githubMirror ? { githubFactory: () => options.githubMirror as IssueMirror & ChangeRequestPublisher } : {}),
        ...(options.githubIssueWorkSource ? { githubIssueWorkSourceFactory: () => options.githubIssueWorkSource as WorkSource<string> } : {}),
        ...(options.githubTokenResolver ? { githubTokenResolver: options.githubTokenResolver } : {})
      }
    : undefined;

  await runCli(["node", "afk", "init"], dependencies);
  rewriteConfig(repoDir, { githubEnabled: options.githubEnabled ?? false });

  if (options.githubEnabled || options.githubIssueWorkSource) {
    process.env.GH_TOKEN = "test-token";
  }

  const config = loadProjectConfig(repoDir);
  const paths = resolveProjectPaths(repoDir, config);
  const store = new SqliteStateStore(paths.statePath);

  return {
    repoDir,
    store,
    githubMirror: options.githubMirror,
    cli: async (args: string[]) => {
      await runCli(["node", "afk", ...args], dependencies);
    },
    capture: async (prompt: string) => {
      await runCli(["node", "afk", "capture", prompt], dependencies);
      return await firstRequirement(store);
    },
    requirement: async () => firstRequirement(store),
    items: async (requirementId: string) => store.listWorkItemsByRequirement(requirementId),
    seedQueue: async (requirementId: string) => {
      const seeded = await store.createDraftWorkItems(requirementId, "Seeded queue", createSeedWorkItems());
      const backend = seeded.find((item) => item.planKey === "backend");
      const frontend = seeded.find((item) => item.planKey === "frontend");
      const review = seeded.find((item) => item.planKey === "review");

      if (!backend || !frontend || !review) {
        throw new Error("Expected seeded queue items to exist");
      }

      await store.updateRequirementStatus(requirementId, "approved");
      await store.updateWorkItemStatus(backend.id, "todo");
      await store.updateWorkItemStatus(frontend.id, "blocked");
      await store.updateWorkItemStatus(review.id, "hitl_pending");
      await runCli(["node", "afk", "sync"], dependencies);
      return await store.listWorkItemsByRequirement(requirementId);
    }
  };
}

async function firstRequirement(store: SqliteStateStore): Promise<Requirement> {
  const [requirement] = await store.listRequirements();

  if (!requirement) {
    throw new Error("Expected a requirement to exist");
  }

  return requirement;
}

function rewriteConfig(repoDir: string, options: { githubEnabled: boolean; runnerRequiredEnv?: string[] }): void {
  const configPath = path.join(repoDir, ".afk", "config.yaml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
  config.github.enabled = options.githubEnabled;
  config.github.owner = options.githubEnabled ? "acme" : undefined;
  config.github.repo = options.githubEnabled ? "demo" : undefined;
  config.runner.command = ["node", "fake-runner.mjs", "{prompt}"];
  config.runner.requiredEnv = options.runnerRequiredEnv ?? [];
  config.runner.envAllowlist = [];
  config.verification = [];
  fs.writeFileSync(configPath, YAML.stringify(config));
}

function createSeedWorkItems(): Array<{
  planKey: string;
  title: string;
  body: string;
  type: "afk" | "hitl";
  acceptanceCriteria: string[];
  dependencyPlanKeys: string[];
}> {
  return [
    {
      planKey: "backend",
      title: "Implement backend queue",
      body: "Create the backend processing flow.",
      type: "afk",
      acceptanceCriteria: ["Backend queue exists"],
      dependencyPlanKeys: []
    },
    {
      planKey: "frontend",
      title: "Wire frontend state",
      body: "Hook the UI into the backend queue.",
      type: "afk",
      acceptanceCriteria: ["UI uses backend queue"],
      dependencyPlanKeys: ["backend"]
    },
    {
      planKey: "review",
      title: "Review UX copy",
      body: "Human must confirm the UX wording.",
      type: "hitl",
      acceptanceCriteria: ["Copy decision recorded"],
      dependencyPlanKeys: []
    }
  ];
}

function writeRepoFiles(repoDir: string, writeWorktreeChange: boolean): void {
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2));
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Fixture\n");
  fs.writeFileSync(
    path.join(repoDir, "fake-runner.mjs"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const promptPath = process.argv.at(-1);
const prompt = fs.readFileSync(promptPath, "utf8");
const match = prompt.match(/Write a JSON file to this exact path(?: when you are done)?:\\n([^\\n]+)/);
if (!match) {
  throw new Error("Missing output marker");
}
const outputPath = match[1].trim();

if (prompt.includes('"items": [')) {
  fs.writeFileSync(outputPath, JSON.stringify({
    summary: "Planned work items",
    items: [
      {
        key: "backend",
        title: "Implement backend queue",
        body: "Create the backend processing flow.",
        type: "afk",
        acceptanceCriteria: ["Backend queue exists"],
        dependsOnKeys: []
      },
      {
        key: "frontend",
        title: "Wire frontend state",
        body: "Hook the UI into the backend queue.",
        type: "afk",
        acceptanceCriteria: ["UI uses backend queue"],
        dependsOnKeys: ["backend"]
      },
      {
        key: "review",
        title: "Review UX copy",
        body: "Human must confirm the UX wording.",
        type: "hitl",
        acceptanceCriteria: ["Copy decision recorded"],
        dependsOnKeys: []
      }
    ]
  }, null, 2));
  process.exit(0);
}

${writeWorktreeChange ? 'fs.writeFileSync(path.join(process.cwd(), "implemented.txt"), "done\\\\n");' : ""}
fs.writeFileSync(outputPath, JSON.stringify({
  status: "done",
  summary: "Completed work item",
  issueComment: "Finished the AFK work item.",
  pr: {
    title: "AFK: complete work item",
    body: "Done"
  }
}, null, 2));
`
  );
}

function writeFakeDocker(fakeBinDir: string): void {
  const dockerPath = path.join(fakeBinDir, "docker");
  fs.writeFileSync(
    dockerPath,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "image" && args[1] === "inspect") {
  process.exit(1);
}
  if (args[0] === "build") {
  process.exit(0);
}
if (args[0] !== "run") {
  process.exit(0);
}

let worktree = process.cwd();
const mounts = new Map();
let index = 1;
while (index < args.length) {
  if (args[index] === "--rm") {
    index += 1;
    continue;
  }
  if (args[index] === "--user") {
    index += 2;
    continue;
  }
  if (args[index] === "-w") {
    index += 2;
    continue;
  }
  if (args[index] === "-v") {
    const [host, container] = args[index + 1].split(":");
    mounts.set(container, host);
    if (container === "/workspace") {
      worktree = host;
    }
    index += 2;
    continue;
  }
  if (args[index] === "-e") {
    index += 2;
    continue;
  }
  break;
}

index += 1;
const command = args[index];
const commandArgs = args.slice(index + 1).map((value) => {
  for (const [container, host] of mounts.entries()) {
    if (value.startsWith(container)) {
      return value.replace(container, host);
    }
  }
  return value;
});

const promptArgIndex = commandArgs.findIndex((value) => value.endsWith(".md"));
if (promptArgIndex >= 0) {
  const originalPromptPath = commandArgs[promptArgIndex];
  let prompt = fs.readFileSync(originalPromptPath, "utf8");
  for (const [container, host] of mounts.entries()) {
    prompt = prompt.split(container).join(host);
  }
  const rewrittenPromptPath = path.join(os.tmpdir(), \`afk-prompt-\${process.pid}-\${Date.now()}.md\`);
  fs.writeFileSync(rewrittenPromptPath, prompt);
  commandArgs[promptArgIndex] = rewrittenPromptPath;
}

const result = spawnSync(command, commandArgs, {
  cwd: worktree,
  stdio: "inherit"
});
process.exit(result.status ?? 1);
`
  );
  fs.chmodSync(dockerPath, 0o755);
}

class MockGitHubMirror implements IssueMirror, ChangeRequestPublisher {
  public readonly requirementMirrorIds: string[] = [];
  public readonly workItemMirrorIds: string[] = [];
  public readonly pullRequestRequests: ChangeRequest[] = [];
  public readonly closedPullRequestNumbers: number[] = [];
  public readonly issueComments: Array<{ issueNumber: number; body: string }> = [];
  private readonly pullRequestStates = new Map<number, { state: "open" | "closed"; merged: boolean }>();

  public async mirrorRequirement(input: { owner: string; repo: string; requirement: Requirement }): Promise<ExternalRef> {
    this.requirementMirrorIds.push(input.requirement.id);
    return createRef("requirement", input.requirement.id, "issue", this.requirementMirrorIds.length);
  }

  public async mirrorWorkItem(input: { owner: string; repo: string; workItem: WorkItem; requirement: Requirement }): Promise<ExternalRef> {
    this.workItemMirrorIds.push(input.workItem.id);
    return createRef("work_item", input.workItem.id, "issue", this.workItemMirrorIds.length + 100);
  }

  public async commentOnIssue(input: { owner: string; repo: string; issueNumber: number; body: string }): Promise<void> {
    this.issueComments.push({ issueNumber: input.issueNumber, body: input.body });
  }

  public async syncIssues(): Promise<Array<{ refId: string; open: boolean; comments: Array<{ id: string; body: string; createdAt: string }> }>> {
    return [];
  }

  public async openPullRequest(input: { owner: string; repo: string; changeRequest: ChangeRequest }): Promise<ExternalRef> {
    this.pullRequestRequests.push(input.changeRequest);
    const ref = createRef("work_item", input.changeRequest.workItemId, "pull_request", this.pullRequestRequests.length + 200);
    this.pullRequestStates.set(ref.remoteNumber, { state: "open", merged: false });
    return ref;
  }

  public async closePullRequest(input: { owner: string; repo: string; pullNumber: number }): Promise<void> {
    this.closedPullRequestNumbers.push(input.pullNumber);
    this.pullRequestStates.set(input.pullNumber, { state: "closed", merged: false });
  }

  public async syncPullRequests(input: { owner: string; repo: string; refs: ExternalRef[] }): Promise<Array<{ refId: string; state: "open" | "closed"; merged: boolean }>> {
    return input.refs.map((ref) => ({
      refId: ref.id,
      ...(this.pullRequestStates.get(ref.remoteNumber) ?? { state: "open", merged: false })
    }));
  }
}

function createRef(
  entityType: ExternalRef["entityType"],
  entityId: string,
  remoteType: ExternalRef["remoteType"],
  remoteNumber: number
): ExternalRef {
  const now = new Date().toISOString();
  return {
    id: `xref_${entityId}_${remoteType}_${remoteNumber}`,
    entityType,
    entityId,
    provider: "github",
    remoteType,
    remoteNumber,
    remoteId: String(remoteNumber),
    url: `https://example.com/${remoteType}/${remoteNumber}`,
    createdAt: now,
    updatedAt: now
  };
}

async function captureConsole(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });

  try {
    await action();
  } finally {
    logSpy.mockRestore();
  }

  return lines.join("\n");
}
