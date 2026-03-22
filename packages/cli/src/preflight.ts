import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandExistsError, formatErrorMessage, withCommandOverride, withRequiredEnv } from "./cli-utils.js";
import type { CliContext, CliDependencies } from "./types.js";

const execFileAsync = promisify(execFile);

const GITHUB_AUTH_PREFLIGHT_TIMEOUT_MS = 8_000;

export function assertPullRequestReady(ctx: CliContext): void {
  if (!ctx.config.github.enabled) {
    throw new Error("Pull request publishing requires github.enabled: true");
  }

  if (!ctx.remote) {
    throw new Error("Pull request publishing requires an origin GitHub remote");
  }

  if (!ctx.github) {
    throw new Error("Pull request publishing requires GitHub auth (`GH_TOKEN` or `gh auth login`)");
  }
}

export function assertRunTargetArguments(target: string, value: string | undefined): void {
  if (target === "file" && !value) {
    throw new Error("Usage: pnpm afk run file <path>");
  }

  if (target === "issue" && !value) {
    throw new Error("Usage: pnpm afk run issue <github-issue-url>");
  }
}

/**
 * Run dynamic preflight checks before any run state is created.
 *
 * Always checks:
 *   - The configured runner executable is present on PATH.
 *   - All runner-required environment variables are set.
 *
 * When --pr is requested, additionally checks:
 *   - The git origin remote is reachable (push readiness).
 *   - The GitHub token is valid (API authentication).
 *
 * Throws with a preflight-category prefix so callers can distinguish failure types:
 *   "Preflight failed (runner): ..."
 *   "Preflight failed (git): ..."
 *   "Preflight failed (github): ..."
 */
export async function runPreflight(
  ctx: CliContext,
  options: { requirePullRequest: boolean },
  dependencies: CliDependencies
): Promise<void> {
  // 1. Verify the runner executable exists on PATH.
  const runnerInvocation = ctx.runner.buildInvocation({
    mode: "work",
    promptPath: "/tmp/prompt.md",
    ...withCommandOverride(ctx.config.runner.command)
  });
  const runnerCommandError = await commandExistsError(runnerInvocation.command, "runner");
  if (runnerCommandError) {
    throw new Error(`Preflight failed (runner): runner executable not found: ${runnerInvocation.command}`);
  }

  // 2. Verify all required runner env vars are present.
  for (const envVar of ctx.runner.requiredEnvVars(withRequiredEnv(ctx.config.runner.requiredEnv))) {
    if (!process.env[envVar]) {
      throw new Error(`Preflight failed (runner): missing required env var ${envVar}`);
    }
  }

  if (options.requirePullRequest) {
    // 3. Verify git origin remote is reachable (push readiness).
    const gitChecker = dependencies.gitRemoteChecker ?? defaultGitRemoteChecker;
    await gitChecker(ctx.repoRoot);

    // 4. Verify the GitHub token can authenticate with the API.
    if (ctx.githubToken && ctx.remote) {
      const authVerifier = dependencies.githubAuthVerifier ?? defaultGitHubAuthVerifier;
      await authVerifier(ctx.githubToken, ctx.remote);
    }
  }
}

async function defaultGitRemoteChecker(repoRoot: string): Promise<void> {
  try {
    await execFileAsync("git", ["ls-remote", "--heads", "origin"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0"
      }
    });
  } catch (error) {
    throw new Error(`Preflight failed (git): origin remote is not accessible: ${formatErrorMessage(error)}`);
  }
}

async function defaultGitHubAuthVerifier(token: string, _remote: { owner: string; repo: string }): Promise<void> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), GITHUB_AUTH_PREFLIGHT_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "afk-geoff/preflight"
      },
      signal: abortController.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Preflight failed (github): GitHub auth check timed out after ${GITHUB_AUTH_PREFLIGHT_TIMEOUT_MS}ms`);
    }

    throw new Error(`Preflight failed (github): GitHub token is invalid or unauthenticated: ${formatErrorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}
