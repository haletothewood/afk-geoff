import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHubMirror, GitHubPullRequestPublisher } from "@afk-geoff/adapter-github";
import { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { AgentRunner } from "@afk-geoff/core";
import { ClaudeCliRunner } from "@afk-geoff/runner-claude";
import { CodexCliRunner } from "@afk-geoff/runner-codex";
import { DockerWorkspaceRuntime } from "@afk-geoff/runtime-docker";
import { ensureProjectLayout, loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";
import { LocalDockerExecutionBackend } from "./local-docker-execution-backend.js";
import { GitHubSourceUpdater, NoOpSourceUpdater, parseGitHubIssueUrl } from "./source-updater.js";
import type { CliContext, CliDependencies } from "./types.js";

const execFileAsync = promisify(execFile);

export async function openContext(cwd: string, dependencies: CliDependencies): Promise<CliContext> {
  const git = new LocalGitCodeHost();
  const repoRoot = await git.assertRepository(cwd);
  const config = loadProjectConfig(repoRoot);
  const executionBackendKind = dependencies.backendOverride ?? config.execution.backend;
  const paths = ensureProjectLayout(repoRoot, config);
  const store = new SqliteStateStore(paths.statePath);
  const runtime = new DockerWorkspaceRuntime();
  const runner = createRunner(config.runner.kind);
  const remote = config.github.enabled ? config.github.owner && config.github.repo ? { owner: config.github.owner, repo: config.github.repo } : await git.getRemoteSlug(repoRoot) : undefined;
  const githubToken = await resolveGitHubToken(dependencies);
  const github = config.github.enabled && githubToken
    ? dependencies.githubFactory
      ? dependencies.githubFactory(githubToken)
      : new GitHubMirror(githubToken)
    : undefined;
  const executionBackend = createExecutionBackend(executionBackendKind, {
    repoRoot,
    config,
    paths,
    store,
    git,
    runtime,
    runner,
    ...(githubToken ? { githubToken } : {})
  });
  const resultPublisher = github && remote
    ? new GitHubPullRequestPublisher(git, github, remote)
    : undefined;

  const sourceUpdaterFactory = (issueUrl: string) => {
    const parsed = parseGitHubIssueUrl(issueUrl);
    if (!parsed) {
      return new NoOpSourceUpdater();
    }
    const issueMirror = github
      ?? (dependencies.githubFactory && githubToken ? dependencies.githubFactory(githubToken) : undefined)
      ?? (githubToken ? new GitHubMirror(githubToken) : undefined);
    if (!issueMirror) {
      return new NoOpSourceUpdater();
    }
    return new GitHubSourceUpdater(issueMirror, parsed.owner, parsed.repo, parsed.issueNumber);
  };

  return {
    cwd,
    repoRoot,
    config,
    paths,
    store,
    git,
    runtime,
    runner,
    executionBackendKind,
    githubToken,
    github,
    executionBackend,
    resultPublisher,
    remote,
    sourceUpdaterFactory
  };
}

function createExecutionBackend(
  kind: CliDependencies["backendOverride"],
  deps: ConstructorParameters<typeof LocalDockerExecutionBackend>[0]
) {
  if (kind === "local-docker") {
    return new LocalDockerExecutionBackend(deps);
  }

  throw new Error(`Unsupported execution backend: ${kind}`);
}

export function createRunner(kind: "claude" | "codex"): AgentRunner {
  return kind === "claude" ? new ClaudeCliRunner() : new CodexCliRunner();
}

export async function resolveGitHubToken(dependencies: CliDependencies): Promise<string | undefined> {
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }

  if (dependencies.githubTokenResolver) {
    return await dependencies.githubTokenResolver();
  }

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}
