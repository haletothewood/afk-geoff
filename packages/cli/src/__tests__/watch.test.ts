import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import { captureConsole, createFixture, makeTempDir, rewriteConfig } from "./test-helpers.js";

describe("afk CLI — watch command", () => {
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
});
