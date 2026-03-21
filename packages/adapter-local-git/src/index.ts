import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { CodeHost } from "@afk-geoff/core";

const execFileAsync = promisify(execFile);

export class LocalGitCodeHost implements CodeHost {
  public async assertRepository(cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  }

  public async getRemoteSlug(cwd: string): Promise<{ owner: string; repo: string } | undefined> {
    try {
      const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd });
      const remote = stdout.trim();
      const match = remote.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);

      if (!match) {
        return undefined;
      }

      return { owner: match[1]!, repo: match[2]! };
    } catch {
      return undefined;
    }
  }

  public async createWorktree(input: { cwd: string; branchName: string; baseBranch: string; path: string }): Promise<void> {
    await execFileAsync("git", ["worktree", "add", "--detach", input.path, input.baseBranch], { cwd: input.cwd });
    await execFileAsync("git", ["checkout", "-B", input.branchName], { cwd: input.path });
  }

  public async removeWorktree(input: { cwd: string; path: string; force?: boolean }): Promise<void> {
    const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), input.path];
    await execFileAsync("git", args, { cwd: input.cwd });
  }

  public async commitAll(input: { cwd: string; message: string }): Promise<{ created: boolean; sha?: string }> {
    const { stdout: status } = await execFileAsync("git", ["status", "--short"], { cwd: input.cwd });

    if (!status.trim()) {
      return { created: false };
    }

    await execFileAsync("git", ["add", "-A"], { cwd: input.cwd });
    await execFileAsync("git", ["commit", "-m", input.message], { cwd: input.cwd });
    const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.cwd });
    return { created: true, sha: sha.trim() };
  }

  public async pushBranch(input: { cwd: string; branchName: string }): Promise<void> {
    await execFileAsync("git", ["push", "-u", "origin", input.branchName], { cwd: input.cwd });
  }

  public async deleteRemoteBranch(input: { cwd: string; branchName: string }): Promise<void> {
    await execFileAsync("git", ["push", "origin", "--delete", input.branchName], { cwd: input.cwd });
  }

  public async deleteLocalBranch(input: { cwd: string; branchName: string }): Promise<void> {
    await execFileAsync("git", ["branch", "-D", input.branchName], { cwd: input.cwd });
  }

  public async hasDiffAgainst(input: { cwd: string; baseBranch: string }): Promise<boolean> {
    try {
      await execFileAsync("git", ["diff", "--quiet", input.baseBranch, "HEAD"], { cwd: input.cwd });
      return false;
    } catch {
      return true;
    }
  }
}

export function branchNameForWorkItem(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "work-item";
  return `afk/${normalized}-${Date.now()}`;
}

export function worktreePath(root: string, worktreesDir: string, runId: string): string {
  return path.join(root, worktreesDir, runId);
}
