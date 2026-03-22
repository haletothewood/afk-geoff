import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createFixture, makeTempDir } from "./test-helpers.js";

describe("afk CLI — cleanup command", () => {
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

  it("dry-run by default: reports what would be removed without deleting anything", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture("Test requirement for cleanup");
    await fixture.seedQueue(requirement.id);
    await fixture.cli(["dispatch", "--max", "1"]);

    const runs = await fixture.store.listRuns();
    const completedRun = runs.find((r) => r.status === "completed");
    expect(completedRun).toBeDefined();

    const runDir = completedRun!.runDir;
    expect(fs.existsSync(runDir)).toBe(true);

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup"]);
    });

    expect(output).toContain("dry-run");
    expect(output).toContain("[dry-run]");
    // Run dir should still exist after a dry-run
    expect(fs.existsSync(runDir)).toBe(true);
  });

  it("--execute deletes run directories for terminal runs", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture("Test requirement for cleanup");
    await fixture.seedQueue(requirement.id);
    await fixture.cli(["dispatch", "--max", "1"]);

    const runs = await fixture.store.listRuns();
    const completedRun = runs.find((r) => r.status === "completed");
    expect(completedRun).toBeDefined();

    const runDir = completedRun!.runDir;
    expect(fs.existsSync(runDir)).toBe(true);

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup", "--execute"]);
    });

    expect(output).toContain("removed:");
    expect(output).toContain("run dir");
    expect(fs.existsSync(runDir)).toBe(false);

    // SQLite run record should still exist
    const runsAfter = await fixture.store.listRuns();
    expect(runsAfter.find((r) => r.id === completedRun!.id)).toBeDefined();
  });

  it("active runs (prepared/running) are skipped and reported", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture("Test requirement for active run protection");
    await fixture.seedQueue(requirement.id);
    const items = await fixture.items(requirement.id);
    const backend = items.find((i) => i.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_active_cleanup");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    await fixture.store.createRun({
      id: "run_active_cleanup",
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup", "--execute"]);
    });

    expect(output).toContain("skipped:");
    expect(output).toContain("run_active_cleanup");
    expect(output).toContain("active run is protected");
    // Run dir must still exist
    expect(fs.existsSync(runDir)).toBe(true);
  });

  it("cleanup is idempotent when run directory is already missing", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture("Test requirement for idempotency");
    await fixture.seedQueue(requirement.id);
    const items = await fixture.items(requirement.id);
    const backend = items.find((i) => i.planKey === "backend");
    expect(backend).toBeDefined();

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_missing_dir");
    // Do NOT create the run dir — simulate already-cleaned state
    await fixture.store.updateWorkItemStatus(backend!.id, "done");
    await fixture.store.createRun({
      id: "run_missing_dir",
      workItemId: backend!.id,
      mode: "work",
      status: "completed",
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    // Should not throw
    await expect(fixture.cli(["cleanup", "--execute"])).resolves.toBeUndefined();
  });

  it("orphan detection: reports orphaned directories not in SQLite without --include-orphans", async () => {
    const fixture = await createFixture(tempDir);

    const orphanRunDir = path.join(fixture.repoDir, ".afk", "runs", "orphan_abc123");
    const orphanWorktreeDir = path.join(fixture.repoDir, ".afk", "worktrees", "orphan_abc123");
    fs.mkdirSync(orphanRunDir, { recursive: true });
    fs.mkdirSync(orphanWorktreeDir, { recursive: true });

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup"]);
    });

    expect(output).toContain("orphan:");
    expect(output).toContain("orphan_abc123");
    expect(output).toContain("no matching run record");
    expect(output).toContain("--include-orphans");

    // Directories still exist
    expect(fs.existsSync(orphanRunDir)).toBe(true);
    expect(fs.existsSync(orphanWorktreeDir)).toBe(true);
  });

  it("--include-orphans --execute deletes orphaned directories", async () => {
    const fixture = await createFixture(tempDir);

    const orphanRunDir = path.join(fixture.repoDir, ".afk", "runs", "orphan_xyz789");
    const orphanWorktreeDir = path.join(fixture.repoDir, ".afk", "worktrees", "orphan_xyz789");
    fs.mkdirSync(orphanRunDir, { recursive: true });
    fs.mkdirSync(orphanWorktreeDir, { recursive: true });

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup", "--execute", "--include-orphans"]);
    });

    expect(output).toContain("orphan:");
    expect(output).toContain("deleted");

    expect(fs.existsSync(orphanRunDir)).toBe(false);
    expect(fs.existsSync(orphanWorktreeDir)).toBe(false);
  });

  it("--include-orphans in dry-run mode reports but does not delete", async () => {
    const fixture = await createFixture(tempDir);

    const orphanDir = path.join(fixture.repoDir, ".afk", "runs", "orphan_dryrun");
    fs.mkdirSync(orphanDir, { recursive: true });

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup", "--include-orphans"]);
    });

    expect(output).toContain("orphan:");
    expect(output).toContain("[dry-run]");
    expect(fs.existsSync(orphanDir)).toBe(true);
  });

  it("local branch is deleted when terminal run has a branch not currently checked out", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture("Test requirement for branch cleanup");
    await fixture.seedQueue(requirement.id);
    const items = await fixture.items(requirement.id);
    const backend = items.find((i) => i.planKey === "backend");
    expect(backend).toBeDefined();

    // Create a real branch to be cleaned up
    const branchName = "afk/cleanup-test-branch";
    execFileSync("git", ["branch", branchName], { cwd: fixture.repoDir });

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_branch_cleanup");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.updateWorkItemStatus(backend!.id, "done");
    await fixture.store.createRun({
      id: "run_branch_cleanup",
      workItemId: backend!.id,
      mode: "work",
      status: "completed",
      branchName,
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup", "--execute"]);
    });

    expect(output).toContain(`removed: branch ${branchName}`);

    // Verify branch no longer exists
    let branchExists = true;
    try {
      execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branchName}`], { cwd: fixture.repoDir, stdio: "pipe" });
    } catch {
      branchExists = false;
    }
    expect(branchExists).toBe(false);
  });

  it("local branch is skipped in dry-run mode", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture("Test requirement for branch dry-run");
    await fixture.seedQueue(requirement.id);
    const items = await fixture.items(requirement.id);
    const backend = items.find((i) => i.planKey === "backend");
    expect(backend).toBeDefined();

    const branchName = "afk/cleanup-dryrun-branch";
    execFileSync("git", ["branch", branchName], { cwd: fixture.repoDir });

    const runDir = path.join(fixture.repoDir, ".afk", "runs", "run_branch_dryrun");
    fs.mkdirSync(runDir, { recursive: true });
    await fixture.store.updateWorkItemStatus(backend!.id, "done");
    await fixture.store.createRun({
      id: "run_branch_dryrun",
      workItemId: backend!.id,
      mode: "work",
      status: "completed",
      branchName,
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup"]);
    });

    expect(output).toContain(`removed: branch ${branchName}`);
    expect(output).toContain("[dry-run]");

    // Branch should still exist
    let branchExists = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branchName}`], { cwd: fixture.repoDir, stdio: "pipe" });
      branchExists = true;
    } catch {
      branchExists = false;
    }
    expect(branchExists).toBe(true);
  });

  it("deletes a terminal run branch after removing that run's worktree", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture("Test requirement for branch cleanup with real worktree");
    await fixture.seedQueue(requirement.id);
    await fixture.cli(["dispatch", "--max", "1"]);

    const runs = await fixture.store.listRuns();
    const completedRun = runs.find((r) => r.status === "completed");
    expect(completedRun).toBeDefined();
    expect(completedRun!.branchName).toBeDefined();
    expect(completedRun!.worktreePath).toBeDefined();
    expect(fs.existsSync(completedRun!.worktreePath!)).toBe(true);

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup", "--execute"]);
    });

    expect(output).toContain(`removed: worktree ${completedRun!.worktreePath}`);
    expect(output).toContain(`removed: branch ${completedRun!.branchName}`);
    expect(fs.existsSync(completedRun!.worktreePath!)).toBe(false);

    let branchExists = true;
    try {
      execFileSync("git", ["rev-parse", "--verify", `refs/heads/${completedRun!.branchName}`], { cwd: fixture.repoDir, stdio: "pipe" });
    } catch {
      branchExists = false;
    }
    expect(branchExists).toBe(false);
  });

  it("does not delete run/worktree paths outside managed AFK artifact roots", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture("Test requirement for cleanup path safety");
    await fixture.seedQueue(requirement.id);
    const items = await fixture.items(requirement.id);
    const backend = items.find((i) => i.planKey === "backend");
    expect(backend).toBeDefined();

    const outsideRunDir = path.join(fixture.repoDir, "outside-run-dir");
    const outsideWorktreeDir = path.join(fixture.repoDir, "outside-worktree-dir");
    fs.mkdirSync(outsideRunDir, { recursive: true });
    fs.mkdirSync(outsideWorktreeDir, { recursive: true });

    await fixture.store.updateWorkItemStatus(backend!.id, "done");
    await fixture.store.createRun({
      id: "run_outside_paths",
      workItemId: backend!.id,
      mode: "work",
      status: "completed",
      runDir: outsideRunDir,
      worktreePath: outsideWorktreeDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const output = await captureConsole(async () => {
      await fixture.cli(["cleanup", "--execute"]);
    });

    expect(output).toContain(`skipped: run dir ${outsideRunDir}`);
    expect(output).toContain(`skipped: worktree ${outsideWorktreeDir}`);
    expect(output).toContain("outside managed AFK artifact roots");
    expect(fs.existsSync(outsideRunDir)).toBe(true);
    expect(fs.existsSync(outsideWorktreeDir)).toBe(true);
  });
});
