import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createFixture, makeTempDir, rewriteConfig } from "./test-helpers.js";

describe("afk CLI — status command", () => {
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

  it("Given a detached process exits before creating artifacts, when status is refreshed, then the run and work item are marked failed", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_dead_detached_status");
    const worktreePath = path.join(fixture.repoDir, ".afk", "worktrees", "run_dead_detached_status");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    await fixture.store.createRun({
      id: "run_dead_detached_status",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/dead-detached-status",
      worktreePath,
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(path.join(runDir, "detach-process.json"), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }, null, 2));
    fs.writeFileSync(
      path.join(runDir, "progress.json"),
      JSON.stringify({ phase: "starting", message: "Detached worker starting", iteration: 0, updatedAt: new Date().toISOString() }, null, 2)
    );

    await fixture.cli(["status"]);

    const refreshed = await fixture.items(requirement.id);
    expect(refreshed.find((item) => item.id === backend!.id)?.status).toBe("failed");
    const staleRun = (await fixture.store.listRuns()).find((run) => run.id === "run_dead_detached_status");
    expect(staleRun?.status).toBe("failed");
    expect(staleRun?.summary).toContain("Detached worker process 999999 exited before creating run artifacts");
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
});
