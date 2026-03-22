import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { ChangeRequest, ChangeRequestPublisher, ExternalRef, IssueMirror, Requirement, WorkItem, WorkSource } from "@afk-geoff/core";
import { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";
import { runCli } from "./index.js";

interface FixtureOptions {
  githubEnabled?: boolean;
  writeWorktreeChange?: boolean;
  runnerScriptSuffix?: string;
  githubMirror?: MockGitHubMirror;
  githubIssueWorkSource?: WorkSource<string>;
  githubTokenResolver?: () => Promise<string | undefined>;
  /** Override the detach launcher so tests can control background spawning. */
  detachLauncher?: (argv: string[], env: NodeJS.ProcessEnv, cwd: string) => { pid: number };
  /** Override the watch poll interval (milliseconds) for testing. */
  watchPollIntervalMs?: number;
  /** Hook called after each watch poll iteration to let tests mutate state. */
  onAfterPoll?: () => Promise<void>;
  /** Override git remote reachability check for preflight. Defaults to no-op (local bare remote is always accessible in tests). */
  gitRemoteChecker?: (repoRoot: string) => Promise<void>;
  /** Override GitHub auth verification for preflight. Defaults to no-op (tests use mock GitHub). */
  githubAuthVerifier?: (token: string, remote: { owner: string; repo: string }) => Promise<void>;
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
  const originalBreakWorktreeGit = process.env.AFK_TEST_BREAK_WORKTREE_GIT;
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

    if (originalBreakWorktreeGit === undefined) {
      delete process.env.AFK_TEST_BREAK_WORKTREE_GIT;
    } else {
      process.env.AFK_TEST_BREAK_WORKTREE_GIT = originalBreakWorktreeGit;
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

  it("Given a newly initialized repo, when init scaffolds project files, then it includes the iteration loop template", async () => {
    const fixture = await createFixture(tempDir);
    const loopPath = path.join(fixture.repoDir, ".afk", "iteration-loop.md");
    const loopTemplate = fs.readFileSync(loopPath, "utf8");

    expect(loopTemplate).toContain("Map all behavior paths");
    expect(loopTemplate).toContain("Run language-specific checks before PR");
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
      JSON.stringify({ phase: "running", message: "Implementing changes", iteration: 3, updatedAt: new Date().toISOString() }, null, 2)
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
      JSON.stringify({ phase: "running", message: "Writing tests", iteration: 7, updatedAt: new Date().toISOString() }, null, 2)
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["show", backend!.id]);
    });

    expect(output).toContain("Active run: run_show_active");
    expect(output).toContain("[running]");
    expect(output).toContain("Writing tests");
    expect(output).toContain("iteration 7");
  });

  it("Given multiple active runs for the same work item, when show is used, then it prefers the newest active run", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const oldRunDir = path.join(fixture.repoDir, ".afk", "runs", "run_old_active");
    const newRunDir = path.join(fixture.repoDir, ".afk", "runs", "run_new_active");
    fs.mkdirSync(oldRunDir, { recursive: true });
    fs.mkdirSync(newRunDir, { recursive: true });

    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    const oldRunCreatedAt = new Date(Date.now() - 10000).toISOString();
    const newRunCreatedAt = new Date(Date.now() - 5000).toISOString();
    await fixture.store.createRun({
      id: "run_old_active",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/old-active",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_old_active"),
      runDir: oldRunDir,
      createdAt: oldRunCreatedAt,
      updatedAt: oldRunCreatedAt
    });
    await fixture.store.createRun({
      id: "run_new_active",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/new-active",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_new_active"),
      runDir: newRunDir,
      createdAt: newRunCreatedAt,
      updatedAt: newRunCreatedAt
    });

    fs.writeFileSync(
      path.join(oldRunDir, "progress.json"),
      JSON.stringify({ phase: "running", message: "Old run", iteration: 1, updatedAt: new Date().toISOString() }, null, 2)
    );
    fs.writeFileSync(
      path.join(newRunDir, "progress.json"),
      JSON.stringify({ phase: "verifying", message: "Newest run", iteration: 4, updatedAt: new Date().toISOString() }, null, 2)
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["show", backend!.id]);
    });

    expect(output).toContain("Active run: run_new_active");
    expect(output).toContain("Newest run");
    expect(output).not.toContain("Old run");
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

  it("Given a running work item that exceeds the configured run timeout, when status is refreshed, then the run and work item are marked failed with a timeout summary", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_timeout");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    await fixture.store.createRun({
      id: "run_timeout",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/timeout",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_timeout"),
      runDir,
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    });

    // Set a very short timeout so the 1-hour-old run is considered timed out
    rewriteConfig(fixture.repoDir, { githubEnabled: false, timeouts: { runTimeoutMs: 1, heartbeatStaleMs: 5 * 60 * 1000 } });

    await fixture.cli(["status"]);

    const refreshed = await fixture.items(requirement.id);
    expect(refreshed.find((item) => item.id === backend!.id)?.status).toBe("failed");
    const timedOutRun = (await fixture.store.listRuns()).find((run) => run.id === "run_timeout");
    expect(timedOutRun?.status).toBe("failed");
    expect(timedOutRun?.summary).toContain("Run timeout exceeded");
  });

  it("Given a running work item with a stale heartbeat beyond the configured window, when status is refreshed, then the run and work item are marked failed with a heartbeat stale summary", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_stale_heartbeat");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    await fixture.store.createRun({
      id: "run_stale_heartbeat",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/stale-heartbeat",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_stale_heartbeat"),
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    // Write a progress file with an old timestamp
    fs.writeFileSync(
      path.join(runDir, "progress.json"),
      JSON.stringify({ phase: "running", message: "Stuck", iteration: 2, updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }, null, 2)
    );

    // Set a very short heartbeat stale window and a long run timeout so only heartbeat fires
    rewriteConfig(fixture.repoDir, { githubEnabled: false, timeouts: { runTimeoutMs: 24 * 60 * 60 * 1000, heartbeatStaleMs: 1 } });

    await fixture.cli(["status"]);

    const refreshed = await fixture.items(requirement.id);
    expect(refreshed.find((item) => item.id === backend!.id)?.status).toBe("failed");
    const staleRun = (await fixture.store.listRuns()).find((run) => run.id === "run_stale_heartbeat");
    expect(staleRun?.status).toBe("failed");
    expect(staleRun?.summary).toContain("Heartbeat stale");
  });

  it("Given a running work item with a tracked worker process and stale heartbeat, when status is refreshed, then AFK terminates the worker process", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_terminate_worker");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    await fixture.store.createRun({
      id: "run_terminate_worker",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/terminate-worker",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_terminate_worker"),
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    expect(typeof sleeper.pid).toBe("number");
    fs.writeFileSync(
      path.join(runDir, "worker-process.json"),
      JSON.stringify({ pid: sleeper.pid, command: "docker", args: ["run"], runtime: "docker" }, null, 2)
    );
    fs.writeFileSync(
      path.join(runDir, "progress.json"),
      JSON.stringify({ phase: "running", message: "Stuck", iteration: 2, updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }, null, 2)
    );

    rewriteConfig(fixture.repoDir, { githubEnabled: false, timeouts: { runTimeoutMs: 24 * 60 * 60 * 1000, heartbeatStaleMs: 1 } });

    try {
      await fixture.cli(["status"]);
      await waitForProcessExit(sleeper.pid!, 1000);
      expect(processExistsForTest(sleeper.pid!)).toBe(false);
    } finally {
      if (sleeper.pid && processExistsForTest(sleeper.pid)) {
        process.kill(sleeper.pid, "SIGKILL");
      }
    }

    const refreshed = await fixture.items(requirement.id);
    expect(refreshed.find((item) => item.id === backend!.id)?.status).toBe("failed");
    const staleRun = (await fixture.store.listRuns()).find((run) => run.id === "run_terminate_worker");
    expect(staleRun?.status).toBe("failed");
    expect(staleRun?.summary).toContain("Heartbeat stale");
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

  it("Given a pending AFK work item, when run --detach is used, then the CLI prints the run id and returns without waiting", async () => {
    const launchCalls: Array<{ argv: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
    const fixture = await createFixture(tempDir, {
      detachLauncher: (argv, env, cwd) => {
        launchCalls.push({ argv, env, cwd });
        return { pid: 0 };
      }
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["run", backend!.id, "--detach"]);
    });

    // Output should contain the run id and follow-up commands.
    expect(output).toMatch(/Run run_[a-z0-9]+/);
    expect(output).toContain("pnpm afk status");
    expect(output).toContain("pnpm afk runs");
    expect(output).not.toContain("pnpm afk watch");

    // A run record should be pre-created in the ledger.
    const runs = await fixture.store.listRuns();
    const detachedRun = runs.find((run) => run.workItemId === backend!.id && run.mode === "work");
    expect(detachedRun).toBeDefined();
    expect(detachedRun?.status).toBe("running");

    // The work item should be marked in_progress so reconciliation can track it.
    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("in_progress");

    // The launcher should have been called once with the run id in the environment.
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]?.env.AFK_DETACH_RUN_ID).toBe(detachedRun?.id);
    expect(launchCalls[0]?.argv).toContain(backend!.id);
  });

  it("Given detached launcher startup fails, when run --detach is used, then the run and work item are marked failed", async () => {
    const fixture = await createFixture(tempDir, {
      detachLauncher: () => {
        throw new Error("simulated launch failure");
      }
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await expect(fixture.cli(["run", backend!.id, "--detach"])).rejects.toThrow("Detached launch failed");

    const refreshedItems = await fixture.items(requirement.id);
    expect(refreshedItems.find((item) => item.id === backend!.id)?.status).toBe("failed");
    const detachedRun = (await fixture.store.listRuns()).find((run) => run.workItemId === backend!.id && run.mode === "work");
    expect(detachedRun?.status).toBe("failed");
    expect(detachedRun?.summary).toContain("Detached launch failed");
  });

  it("Given a detached run has been started, when status and runs are used, then the detached run appears as active", async () => {
    const fixture = await createFixture(tempDir, {
      detachLauncher: () => ({ pid: 0 })
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id, "--detach"]);

    const runs = await fixture.store.listRuns();
    const detachedRun = runs.find((run) => run.workItemId === backend!.id && run.mode === "work");
    expect(detachedRun).toBeDefined();

    const statusOutput = await captureConsole(async () => {
      await fixture.cli(["status"]);
    });
    expect(statusOutput).toContain(detachedRun!.id);
    expect(statusOutput).toContain("running");

    const runsOutput = await captureConsole(async () => {
      await fixture.cli(["runs"]);
    });
    expect(runsOutput).toContain(detachedRun!.id);
    expect(runsOutput).toContain(backend!.id);
  });

  it("Given a detached run with a stale heartbeat beyond the configured window, when status is refreshed, then the run and work item are marked failed", async () => {
    const fixture = await createFixture(tempDir, {
      detachLauncher: () => ({ pid: 0 })
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id, "--detach"]);

    // Write a progress file with a stale timestamp to simulate the worker going silent.
    const runs = await fixture.store.listRuns();
    const detachedRun = runs.find((run) => run.workItemId === backend!.id && run.mode === "work");
    expect(detachedRun).toBeDefined();
    fs.writeFileSync(
      path.join(detachedRun!.runDir, "progress.json"),
      JSON.stringify({ phase: "running", message: "Stuck", iteration: 1, updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }, null, 2)
    );

    // Set a very short heartbeat window and a long run timeout so only heartbeat fires.
    rewriteConfig(fixture.repoDir, { githubEnabled: false, timeouts: { runTimeoutMs: 24 * 60 * 60 * 1000, heartbeatStaleMs: 1 } });

    await fixture.cli(["status"]);

    const refreshedItems = await fixture.items(requirement.id);
    expect(refreshedItems.find((item) => item.id === backend!.id)?.status).toBe("failed");
    const refreshedRun = (await fixture.store.listRuns()).find((run) => run.id === detachedRun!.id);
    expect(refreshedRun?.status).toBe("failed");
    expect(refreshedRun?.summary).toContain("Heartbeat stale");
  });

  it("Given an execution brief file, when run file --detach is used, then it creates tracked state and starts a background worker with brief options", async () => {
    const launchCalls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
    const fixture = await createFixture(tempDir, {
      detachLauncher: (argv, env) => {
        launchCalls.push({ argv, env });
        return { pid: 0 };
      }
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
        "Add file-backed detached execution",
        "",
        "## Work Item Body",
        "Run a work item in the background from a brief file.",
        "",
        "## Acceptance Criteria",
        "- The detached run is tracked in the ledger",
        "",
        "## Verification",
        "- pnpm typecheck",
        "",
        "## GitHub Issue",
        "https://github.com/acme/demo/issues/77"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md", "--detach"]);
    });

    expect(output).toContain("Imported execution brief");
    expect(output).toMatch(/Run run_[a-z0-9]+/);
    expect(output).toContain("pnpm afk status");

    const runs = await fixture.store.listRuns();
    expect(runs.some((run) => run.status === "running")).toBe(true);
    expect(launchCalls).toHaveLength(1);
    const detachedOptions = JSON.parse(launchCalls[0]!.env.AFK_DETACH_RUN_OPTIONS ?? "{}") as { verification?: string[]; issueUrl?: string };
    expect(detachedOptions.verification).toEqual(["pnpm typecheck"]);
    expect(detachedOptions.issueUrl).toBe("https://github.com/acme/demo/issues/77");
  });

  it("Given an issue work source, when run issue --detach is used, then detached options include issue URL and verification", async () => {
    const launchCalls: Array<{ env: NodeJS.ProcessEnv }> = [];
    const fixture = await createFixture(tempDir, {
      githubIssueWorkSource: {
        async load() {
          return {
            requirementBody: "Ship a narrow internal improvement for the AFK runner.",
            workItemTitle: "Run from issue in detach mode",
            workItemBody: "Execute a hand-authored GitHub issue body.",
            acceptanceCriteria: ["The runner can import a GitHub issue body"],
            verification: ["pnpm typecheck", "pnpm test -- packages/cli/src/index.test.ts"],
            issueUrl: "https://github.com/acme/demo/issues/42"
          };
        }
      },
      detachLauncher: (_argv, env) => {
        launchCalls.push({ env });
        return { pid: 0 };
      }
    });

    await fixture.cli(["run", "issue", "https://github.com/acme/demo/issues/42", "--detach"]);

    expect(launchCalls).toHaveLength(1);
    const detachedOptions = JSON.parse(launchCalls[0]!.env.AFK_DETACH_RUN_OPTIONS ?? "{}") as { verification?: string[]; issueUrl?: string };
    expect(detachedOptions.verification).toEqual(["pnpm typecheck", "pnpm test -- packages/cli/src/index.test.ts"]);
    expect(detachedOptions.issueUrl).toBe("https://github.com/acme/demo/issues/42");
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

  it("Given an unknown run id, when watch is used, then it fails fast with a clear error", async () => {
    const fixture = await createFixture(tempDir);

    await expect(fixture.cli(["watch", "run_does_not_exist"])).rejects.toThrow("Run run_does_not_exist not found");
  });

  it("Given an already-completed run, when watch is used, then it prints status and exits zero", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_watch_done");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.createRun({
      id: "run_watch_done",
      workItemId: backend!.id,
      mode: "work",
      status: "completed",
      branchName: "afk/watch-done",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_watch_done"),
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await fixture.store.updateRun("run_watch_done", { summary: "All checks passed" });
    fs.writeFileSync(path.join(runDir, "stdout.log"), "worker finished successfully\n");
    fs.writeFileSync(path.join(runDir, "stderr.log"), "");

    const output = await captureConsole(async () => {
      await fixture.cli(["watch", "run_watch_done"]);
    });

    expect(output).toContain("run_watch_done completed");
    expect(output).toContain("All checks passed");
    expect(output).toContain("worker finished successfully");
  });

  it("Given an already-failed run, when watch is used, then it prints status and exits zero", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_watch_failed");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.createRun({
      id: "run_watch_failed",
      workItemId: backend!.id,
      mode: "work",
      status: "failed",
      branchName: "afk/watch-failed",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", "run_watch_failed"),
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await fixture.store.updateRun("run_watch_failed", { summary: "Worker crashed" });
    fs.writeFileSync(path.join(runDir, "stderr.log"), "fatal: something went wrong\n");

    const output = await captureConsole(async () => {
      await fixture.cli(["watch", "run_watch_failed"]);
    });

    expect(output).toContain("run_watch_failed failed");
    expect(output).toContain("Worker crashed");
    expect(output).toContain("fatal: something went wrong");
  });

  it("Given an active run, when watch is used, then it streams stdout and progress then exits when the run completes", async () => {
    const runId = "run_watch_active";
    let resolveStore: ((store: SqliteStateStore) => void) | undefined;
    const storePromise = new Promise<SqliteStateStore>((resolve) => { resolveStore = resolve; });

    const fixture = await createFixture(tempDir, {
      watchPollIntervalMs: 0,
      onAfterPoll: async () => {
        const store = await storePromise;
        await store.updateRun(runId, { status: "completed", summary: "Work done" });
      }
    });
    resolveStore!(fixture.store);

    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.createRun({
      id: runId,
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/watch-active",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", runId),
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(path.join(runDir, "stdout.log"), "live output from worker\n");
    fs.writeFileSync(
      path.join(runDir, "progress.json"),
      JSON.stringify({ phase: "verifying", message: "Running checks", iteration: 2, updatedAt: new Date().toISOString() }, null, 2)
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["watch", runId]);
    });

    expect(output).toContain("Watching run");
    expect(output).toContain("live output from worker");
    expect(output).toContain("[progress]");
    expect(output).toContain("verifying");
    expect(output).toContain("Running checks");
    expect(output).toContain("run_watch_active completed");
    expect(output).toContain("Work done");
  });

  it("Given an active run with a stale heartbeat, when watch is used, then it prints a stale warning", async () => {
    const runId = "run_watch_stale";
    let resolveStore: ((store: SqliteStateStore) => void) | undefined;
    const storePromise = new Promise<SqliteStateStore>((resolve) => { resolveStore = resolve; });

    const fixture = await createFixture(tempDir, {
      watchPollIntervalMs: 0,
      onAfterPoll: async () => {
        const store = await storePromise;
        await store.updateRun(runId, { status: "completed", summary: "Recovered" });
      }
    });
    resolveStore!(fixture.store);

    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.createRun({
      id: runId,
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/watch-stale",
      worktreePath: path.join(fixture.repoDir, ".afk", "worktrees", runId),
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    // Write a stale progress file (30 minutes ago).
    fs.writeFileSync(
      path.join(runDir, "progress.json"),
      JSON.stringify({ phase: "running", message: "Stuck", iteration: 1, updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }, null, 2)
    );

    rewriteConfig(fixture.repoDir, { githubEnabled: false, timeouts: { runTimeoutMs: 24 * 60 * 60 * 1000, heartbeatStaleMs: 1 } });

    const output = await captureConsole(async () => {
      await fixture.cli(["watch", runId]);
    });

    expect(output).toContain("Warning: heartbeat stale");
    expect(output).toContain("run_watch_stale completed");
  });

  // ---------------------------------------------------------------------------
  // Preflight hardening tests
  // ---------------------------------------------------------------------------

  it("Given run file is missing a path, when preflight would fail, then usage validation runs first", async () => {
    const fixture = await createFixture(tempDir);

    // If preflight ran first this would fail with a runner preflight error instead.
    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerCommand: ["__afk_nonexistent_runner__", "{prompt}"]
    });

    await expect(fixture.cli(["run", "file"])).rejects.toThrow("Usage: pnpm afk run file <path>");
    expect(await fixture.store.listRuns()).toHaveLength(0);
  });

  it("Given the runner executable is not on PATH, when run is used, then it fails with a runner preflight error before creating any run records", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerCommand: ["__afk_nonexistent_runner__", "{prompt}"]
    });

    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow("Preflight failed (runner):");
    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow("__afk_nonexistent_runner__");

    // No run record should have been created.
    expect(await fixture.store.listRuns()).toHaveLength(0);
    // Work item status must not have changed.
    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("todo");
  });

  it("Given a required runner env var is missing, when run is used, then it fails with a runner preflight error before creating any run records", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerRequiredEnv: ["AFK_TEST_PREFLIGHT_MISSING_VAR"]
    });
    delete process.env.AFK_TEST_PREFLIGHT_MISSING_VAR;

    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow("Preflight failed (runner):");
    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow("AFK_TEST_PREFLIGHT_MISSING_VAR");

    // No run record should have been created.
    expect(await fixture.store.listRuns()).toHaveLength(0);
    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("todo");
  });

  it("Given the git origin remote is not accessible, when run --pr is used, then it fails with a git preflight error before creating any run records", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror,
      gitRemoteChecker: async () => {
        throw new Error("Preflight failed (git): origin remote is not accessible: could not connect");
      }
    });
    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Ship a narrow internal improvement.",
        "",
        "## Work Item Title",
        "Git remote preflight check",
        "",
        "## Work Item Body",
        "Verify git push readiness up front.",
        "",
        "## Acceptance Criteria",
        "- Git remote is accessible before run starts"
      ].join("\n")
    );

    await expect(fixture.cli(["run", "file", "brief.md", "--pr"])).rejects.toThrow("Preflight failed (git):");

    // No run record should have been created.
    expect(await fixture.store.listRuns()).toHaveLength(0);
    expect(githubMirror.pullRequestRequests).toHaveLength(0);
  });

  it("Given GitHub auth is invalid, when run --pr is used, then it fails with a github preflight error before creating any run records", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror,
      githubAuthVerifier: async () => {
        throw new Error("Preflight failed (github): GitHub token is invalid or unauthenticated: HTTP 401");
      }
    });
    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Ship a narrow internal improvement.",
        "",
        "## Work Item Title",
        "GitHub auth preflight check",
        "",
        "## Work Item Body",
        "Verify GitHub token validity up front.",
        "",
        "## Acceptance Criteria",
        "- GitHub auth is valid before run starts"
      ].join("\n")
    );

    await expect(fixture.cli(["run", "file", "brief.md", "--pr"])).rejects.toThrow("Preflight failed (github):");

    // No run record should have been created.
    expect(await fixture.store.listRuns()).toHaveLength(0);
    expect(githubMirror.pullRequestRequests).toHaveLength(0);
  });

  it("Given all preflight checks pass, when run is used, then the run proceeds normally", async () => {
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
    expect(await fixture.store.listRuns()).toHaveLength(1);
  });

  it("Given runner preflight fails, when run --detach is used, then it fails before creating any run records", async () => {
    const launchCalls: Array<unknown> = [];
    const fixture = await createFixture(tempDir, {
      detachLauncher: (argv, env, cwd) => {
        launchCalls.push({ argv, env, cwd });
        return { pid: 0 };
      }
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerCommand: ["__afk_nonexistent_detach_runner__", "{prompt}"]
    });

    await expect(fixture.cli(["run", backend!.id, "--detach"])).rejects.toThrow("Preflight failed (runner):");

    // Detached launcher must not have been called and no run record must exist.
    expect(launchCalls).toHaveLength(0);
    expect(await fixture.store.listRuns()).toHaveLength(0);
    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("todo");
  });
});

async function createFixture(tempDir: string, options: FixtureOptions = {}): Promise<WorkflowFixture> {
  const repoDir = path.join(tempDir, "repo");
  const fakeBinDir = path.join(tempDir, "bin");
  const remoteDir = path.join(tempDir, "remote.git");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });

  writeFakeDocker(fakeBinDir);
  writeRepoFiles(repoDir, options.writeWorktreeChange ?? true, options.runnerScriptSuffix);
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

  // Always inject a no-op GitHub auth verifier so tests never make real API calls.
  // When a specific verifier is provided in options it overrides this default.
  const dependencies = {
    ...(options.githubMirror ? { githubFactory: () => options.githubMirror as IssueMirror & ChangeRequestPublisher } : {}),
    ...(options.githubIssueWorkSource ? { githubIssueWorkSourceFactory: () => options.githubIssueWorkSource as WorkSource<string> } : {}),
    ...(options.githubTokenResolver ? { githubTokenResolver: options.githubTokenResolver } : {}),
    ...(options.detachLauncher ? { detachLauncher: options.detachLauncher } : {}),
    ...(options.watchPollIntervalMs !== undefined ? { watchPollIntervalMs: options.watchPollIntervalMs } : {}),
    ...(options.onAfterPoll ? { onAfterPoll: options.onAfterPoll } : {}),
    ...(options.gitRemoteChecker !== undefined ? { gitRemoteChecker: options.gitRemoteChecker } : {}),
    // Default: no-op so tests never make real GitHub API calls; override explicitly for auth-failure tests.
    githubAuthVerifier: options.githubAuthVerifier ?? (async () => {})
  };

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
      await runCli(["node", "afk", ...args], dependencies ?? {});
    },
    capture: async (prompt: string) => {
      await runCli(["node", "afk", "capture", prompt], dependencies ?? {});
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

function rewriteConfig(repoDir: string, options: { githubEnabled: boolean; runnerRequiredEnv?: string[]; runnerCommand?: string[]; timeouts?: { runTimeoutMs?: number; heartbeatStaleMs?: number } }): void {
  const configPath = path.join(repoDir, ".afk", "config.yaml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
  config.github.enabled = options.githubEnabled;
  config.github.owner = options.githubEnabled ? "acme" : undefined;
  config.github.repo = options.githubEnabled ? "demo" : undefined;
  config.runner.command = options.runnerCommand ?? ["node", "fake-runner.mjs", "{prompt}"];
  config.runner.requiredEnv = options.runnerRequiredEnv ?? [];
  config.runner.envAllowlist = [];
  config.verification = [];
  if (options.timeouts) {
    config.timeouts = options.timeouts;
  }
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

function writeRepoFiles(repoDir: string, writeWorktreeChange: boolean, runnerScriptSuffix?: string): void {
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2));
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Fixture\n");
  fs.writeFileSync(
    path.join(repoDir, "fake-runner.mjs"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
${runnerScriptSuffix ?? ""}
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
let workdir = process.cwd();
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
  if (args[index] === "--name") {
    index += 2;
    continue;
  }
  if (args[index] === "-w") {
    workdir = args[index + 1];
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

for (const [container, host] of mounts.entries()) {
  if (workdir.startsWith(container)) {
    worktree = workdir.replace(container, host);
    break;
  }
}

if (process.env.AFK_TEST_BREAK_WORKTREE_GIT === "1") {
  const expectedGitDir = path.resolve(worktree, "..", "..", "..", ".git");
  const hasRealWorktreeMount = mounts.has(worktree);
  const hasSharedGitMount = mounts.has(expectedGitDir);

  if (!hasRealWorktreeMount || !hasSharedGitMount || workdir !== worktree) {
    const worktreeGitPath = path.join(worktree, ".git");
    if (fs.existsSync(worktreeGitPath) && fs.lstatSync(worktreeGitPath).isFile()) {
      fs.unlinkSync(worktreeGitPath);
      spawnSync("git", ["init"], { cwd: worktree, stdio: "inherit" });
      spawnSync("git", ["config", "user.email", "agent@afk"], { cwd: worktree, stdio: "inherit" });
      spawnSync("git", ["config", "user.name", "AFK Agent"], { cwd: worktree, stdio: "inherit" });
    }
  }
}

index += 1;
const command = args[index];
let commandArgs = args.slice(index + 1).map((value) => {
  let rewritten = value;
  for (const [container, host] of mounts.entries()) {
    rewritten = rewritten.split(container).join(host);
  }
  return rewritten;
});

const promptPaths = new Set();
for (const value of commandArgs) {
  const matches = value.match(/\\/[A-Za-z0-9._\\/-]+\\.md/g) ?? [];
  for (const promptPath of matches) {
    promptPaths.add(promptPath);
  }
}

const rewrittenPromptPaths = new Map();
for (const promptPath of promptPaths) {
  if (!fs.existsSync(promptPath)) {
    continue;
  }
  let prompt = fs.readFileSync(promptPath, "utf8");
  for (const [container, host] of mounts.entries()) {
    prompt = prompt.split(container).join(host);
  }
  const rewrittenPromptPath = path.join(os.tmpdir(), \`afk-prompt-\${process.pid}-\${Date.now()}-\${Math.random().toString(16).slice(2)}.md\`);
  fs.writeFileSync(rewrittenPromptPath, prompt);
  rewrittenPromptPaths.set(promptPath, rewrittenPromptPath);
}

if (rewrittenPromptPaths.size > 0) {
  commandArgs = commandArgs.map((value) => {
    let rewritten = value;
    for (const [originalPromptPath, rewrittenPromptPath] of rewrittenPromptPaths.entries()) {
      rewritten = rewritten.split(originalPromptPath).join(rewrittenPromptPath);
    }
    return rewritten;
  });
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

function processExistsForTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!processExistsForTest(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

class MockGitHubMirror implements IssueMirror, ChangeRequestPublisher {
  public readonly requirementMirrorIds: string[] = [];
  public readonly workItemMirrorIds: string[] = [];
  public readonly pullRequestRequests: ChangeRequest[] = [];
  public readonly closedPullRequestNumbers: number[] = [];
  public readonly issueComments: Array<{ issueNumber: number; body: string }> = [];
  public openPullRequestError: Error | undefined;
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
    if (this.openPullRequestError) {
      throw this.openPullRequestError;
    }
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
