import { execFile } from "node:child_process";
import fs from "node:fs";
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

  public async createWorktreeFromBranch(input: { cwd: string; branchName: string; path: string }): Promise<void> {
    try {
      await execFileAsync("git", ["fetch", "origin", input.branchName], { cwd: input.cwd });
    } catch {
      // Local-only branches are valid for tests and non-GitHub workflows.
    }

    try {
      await execFileAsync("git", ["worktree", "add", input.path, input.branchName], { cwd: input.cwd });
    } catch {
      await execFileAsync("git", ["worktree", "add", "-b", input.branchName, input.path, `origin/${input.branchName}`], { cwd: input.cwd });
    }
  }

  public async removeWorktree(input: { cwd: string; path: string; force?: boolean }): Promise<void> {
    const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), input.path];
    await execFileAsync("git", args, { cwd: input.cwd });
  }

  public async commitAll(input: { cwd: string; message: string }): Promise<{ created: boolean; sha?: string }> {
    await this.discardGeneratedArtifacts({ cwd: input.cwd });
    const { stdout: status } = await execFileAsync("git", ["status", "--short"], { cwd: input.cwd });

    if (!status.trim()) {
      return { created: false };
    }

    await execFileAsync("git", ["add", "-A"], { cwd: input.cwd });
    await execFileAsync("git", ["commit", "-m", input.message], { cwd: input.cwd });
    const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.cwd });
    return { created: true, sha: sha.trim() };
  }

  public async discardGeneratedArtifacts(input: { cwd: string }): Promise<string[]> {
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: input.cwd });
    const artifactPaths = status
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => line.slice(3))
      .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1)! : line)
      .filter(isGeneratedArtifactPath);

    const uniqueArtifactPaths = [...new Set(artifactPaths)];
    for (const artifactPath of uniqueArtifactPaths) {
      if (await isTracked(input.cwd, artifactPath)) {
        await execFileAsync("git", ["restore", "--staged", "--worktree", "--", artifactPath], { cwd: input.cwd });
      } else {
        fs.rmSync(path.join(input.cwd, artifactPath), { force: true, recursive: true });
      }
    }

    return uniqueArtifactPaths;
  }

  public async pushBranch(input: { cwd: string; branchName: string }): Promise<void> {
    const { stdout: currentBranch } = await execFileAsync("git", ["branch", "--show-current"], { cwd: input.cwd });
    if (currentBranch.trim() === input.branchName) {
      await execFileAsync("git", ["push", "-u", "origin", input.branchName], { cwd: input.cwd });
      return;
    }
    await execFileAsync("git", ["push", "origin", `HEAD:refs/heads/${input.branchName}`], { cwd: input.cwd });
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

async function isTracked(cwd: string, pathname: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", pathname], { cwd });
    return true;
  } catch {
    return false;
  }
}

function isGeneratedArtifactPath(pathname: string): boolean {
  return path.basename(pathname) === "tsconfig.tsbuildinfo" || pathname.endsWith(".tsbuildinfo");
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
