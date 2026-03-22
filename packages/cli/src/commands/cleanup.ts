import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunRecord } from "@afk-geoff/core";
import type { CliContext } from "../types.js";

const execFileAsync = promisify(execFile);

export interface CleanupOptions {
  execute: boolean;
  includeOrphans: boolean;
}

export async function cleanupArtifacts(ctx: CliContext, options: CleanupOptions): Promise<void> {
  const { execute, includeOrphans } = options;
  const dryRun = !execute;

  if (dryRun) {
    console.log("dry-run: no deletions will be performed (pass --execute to apply)");
    console.log("");
  }

  const runs = await ctx.store.listRuns();
  const knownRunIds = new Set(runs.map((r) => r.id));
  const checkedOutBranches = await getCheckedOutBranches(ctx.repoRoot);

  for (const run of runs) {
    const isActive = run.status === "prepared" || run.status === "running";
    const isTerminal = run.status === "completed" || run.status === "failed";

    if (isActive) {
      console.log(`skipped: run ${run.id} (${run.status}) — active run is protected`);
      continue;
    }

    if (isTerminal) {
      await processTerminalRun(ctx, run, checkedOutBranches, dryRun);
    }
  }

  await detectOrphans(ctx, knownRunIds, includeOrphans, dryRun);
}

async function getCheckedOutBranches(repoRoot: string): Promise<Set<string>> {
  const branches = new Set<string>();
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
    for (const line of stdout.split("\n")) {
      const match = line.match(/^branch refs\/heads\/(.+)$/);
      if (match && match[1]) {
        branches.add(match[1]);
      }
    }
  } catch {
    // Ignore errors — if git fails, assume no branches are checked out in worktrees
  }
  return branches;
}

async function processTerminalRun(
  ctx: CliContext,
  run: RunRecord,
  checkedOutBranches: Set<string>,
  dryRun: boolean
): Promise<void> {
  const tag = `run ${run.id}`;

  // Remove run directory
  if (run.runDir && fs.existsSync(run.runDir)) {
    if (dryRun) {
      console.log(`removed: run dir ${run.runDir} (${tag}) [dry-run]`);
    } else {
      fs.rmSync(run.runDir, { recursive: true, force: true });
      console.log(`removed: run dir ${run.runDir} (${tag})`);
    }
  }

  // Remove worktree
  if (run.worktreePath) {
    if (fs.existsSync(run.worktreePath)) {
      if (dryRun) {
        console.log(`removed: worktree ${run.worktreePath} (${tag}) [dry-run]`);
      } else {
        const removed = await tryRemoveWorktree(ctx, run.worktreePath);
        if (removed) {
          console.log(`removed: worktree ${run.worktreePath} (${tag})`);
        } else {
          console.log(`skipped: worktree ${run.worktreePath} (${tag}) — could not remove`);
        }
      }
    }
  }

  // Delete local branch
  if (run.branchName) {
    if (checkedOutBranches.has(run.branchName)) {
      console.log(`skipped: branch ${run.branchName} (${tag}) — currently checked out in a worktree`);
    } else {
      const exists = await localBranchExists(ctx.repoRoot, run.branchName);
      if (exists) {
        if (dryRun) {
          console.log(`removed: branch ${run.branchName} (${tag}) [dry-run]`);
        } else {
          try {
            await ctx.git.deleteLocalBranch({ cwd: ctx.repoRoot, branchName: run.branchName });
            console.log(`removed: branch ${run.branchName} (${tag})`);
          } catch {
            console.log(`skipped: branch ${run.branchName} (${tag}) — could not delete`);
          }
        }
      }
    }
  }
}

async function tryRemoveWorktree(ctx: CliContext, worktreePath: string): Promise<boolean> {
  try {
    await ctx.git.removeWorktree({ cwd: ctx.repoRoot, path: worktreePath, force: true });
    return true;
  } catch {
    // Fallback for broken worktrees: remove directory then prune
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      await execFileAsync("git", ["worktree", "prune"], { cwd: ctx.repoRoot });
      return true;
    } catch {
      return false;
    }
  }
}

async function localBranchExists(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${branchName}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function detectOrphans(
  ctx: CliContext,
  knownRunIds: Set<string>,
  includeOrphans: boolean,
  dryRun: boolean
): Promise<void> {
  await scanOrphanDir(ctx.paths.runsDir, knownRunIds, "run dir", includeOrphans, dryRun, async (dirPath) => {
    fs.rmSync(dirPath, { recursive: true, force: true });
  });

  await scanOrphanDir(ctx.paths.worktreesDir, knownRunIds, "worktree", includeOrphans, dryRun, async (dirPath) => {
    fs.rmSync(dirPath, { recursive: true, force: true });
    try {
      await execFileAsync("git", ["worktree", "prune"], { cwd: ctx.repoRoot });
    } catch {
      // Best-effort prune
    }
  });
}

async function scanOrphanDir(
  dir: string,
  knownRunIds: Set<string>,
  label: string,
  includeOrphans: boolean,
  dryRun: boolean,
  doDelete: (dirPath: string) => Promise<void>
): Promise<void> {
  if (!fs.existsSync(dir)) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (knownRunIds.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (includeOrphans) {
      if (dryRun) {
        console.log(`orphan: ${label} ${fullPath} — no matching run record, would delete [dry-run]`);
      } else {
        await doDelete(fullPath);
        console.log(`orphan: ${label} ${fullPath} — deleted (no matching run record)`);
      }
    } else {
      console.log(`orphan: ${label} ${fullPath} — no matching run record (use --include-orphans to delete)`);
    }
  }
}
