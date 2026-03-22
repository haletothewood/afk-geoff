import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createFixture, makeTempDir } from "./test-helpers.js";

describe("afk CLI — show command", () => {
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

  it("Given a running work item with a tracked worker process and stale heartbeat, when status is refreshed, then AFK terminates the worker process", async () => {
    const { spawn } = await import("node:child_process");
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

    const { rewriteConfig } = await import("./test-helpers.js");
    rewriteConfig(fixture.repoDir, { githubEnabled: false, timeouts: { runTimeoutMs: 24 * 60 * 60 * 1000, heartbeatStaleMs: 1 } });

    const { processExistsForTest, waitForProcessExit } = await import("./test-helpers.js");

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
