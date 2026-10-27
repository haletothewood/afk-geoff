import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHubMirror, GitHubPullRequestPublisher } from "@afk-geoff/adapter-github";
import { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { AgentRunner, RunnerKind } from "@afk-geoff/core";
import { ClaudeCliRunner } from "@afk-geoff/runner-claude";
import { CodexCliRunner } from "@afk-geoff/runner-codex";
import { DockerWorkspaceRuntime } from "@afk-geoff/runtime-docker";
import { ensureProjectLayout, loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";
import { LocalDockerExecutionBackend } from "./local-docker-execution-backend.js";
import { LocalProcessWorkspaceRuntime } from "./local-process-runtime.js";
import { GitHubSourceUpdater, NoOpSourceUpdater, parseGitHubIssueUrl } from "./source-updater.js";
import type { CliContext, CliDependencies } from "./types.js";
import { resolveCommitSigningPolicy } from "./commit-signing-policy.js";

const execFileAsync = promisify(execFile);

export async function openContext(cwd: string, dependencies: CliDependencies): Promise<CliContext> {
  const git = new LocalGitCodeHost();
  const repoRoot = await git.assertRepository(cwd);
  const config = loadProjectConfig(repoRoot);
  const executionBackendKind = dependencies.backendOverride ?? config.execution.backend;
  const paths = ensureProjectLayout(repoRoot, config);
  const store = new SqliteStateStore(paths.statePath);
  const runtime = executionBackendKind === "local-process" ? new LocalProcessWorkspaceRuntime() : new DockerWorkspaceRuntime();
  const runner = createRunner(config.runner.kind);
  const remote = config.github.enabled ? config.github.owner && config.github.repo ? { owner: config.github.owner, repo: config.github.repo } : await git.getRemoteSlug(repoRoot) : undefined;
  const githubToken = await resolveGitHubToken(dependencies);
  const github = config.github.enabled && githubToken
    ? dependencies.githubFactory
      ? dependencies.githubFactory(githubToken)
      : new GitHubMirror(githubToken)
    : undefined;
  const commitSigningPolicy = await resolveCommitSigningPolicy({
    repoRoot,
    baseBranch: config.baseBranch,
    mode: config.git.signing.mode,
    ...(config.git.signing.key ? { key: config.git.signing.key } : {}),
    githubEnabled: config.github.enabled,
    ...(remote ? { remote } : {}),
    ...(githubToken ? { githubToken } : {}),
    ...(dependencies.targetCommitSignaturePolicyResolver
      ? { targetPolicyResolver: dependencies.targetCommitSignaturePolicyResolver }
      : {}),
    ...(dependencies.signingCapabilityResolver ? { capabilityResolver: dependencies.signingCapabilityResolver } : {})
  });
  const executionBackend = createExecutionBackend(executionBackendKind, {
    repoRoot,
    config,
    paths,
    store,
    git,
    runtime,
    runner,
    commitSigningPolicy,
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
    commitSigningPolicy,
    sourceUpdaterFactory
  };
}

function createExecutionBackend(
  kind: CliDependencies["backendOverride"],
  deps: ConstructorParameters<typeof LocalDockerExecutionBackend>[0]
) {
  if (kind === "local-docker" || kind === "local-process") {
    return new LocalDockerExecutionBackend(deps);
  }

  throw new Error(`Unsupported execution backend: ${kind}`);
}

export function createRunner(kind: RunnerKind): AgentRunner {
  if (kind === "claude") {
    return new ClaudeCliRunner();
  }

  if (kind === "codex") {
    return new CodexCliRunner();
  }

  return new CustomCommandRunner();
}

class CustomCommandRunner implements AgentRunner {
  public readonly kind = "custom" as const;

  public requiredEnvVars(input?: { requiredEnv?: string[] }): string[] {
    return input?.requiredEnv ?? [];
  }

  public buildInvocation(input: {
    mode: "plan" | "work";
    promptPath: string;
    commandOverride?: string[];
    model?: string;
  }): { command: string; args: string[]; promptTransport: "arg" | "stdin" } {
    if (!input.commandOverride) {
      throw new Error("Custom runner requires runner.command in .afk/config.yaml");
    }

    return { ...resolveCommand(input.commandOverride, input.promptPath), promptTransport: "arg" };
  }

  public buildReviewCommand(input: { briefPath: string; reviewCommandOverride?: string[]; commandOverride?: string[] }): string[] {
    return resolveCommandParts(requiredCustomCommand(input.reviewCommandOverride ?? input.commandOverride), input.briefPath);
  }

  public buildReviewInvocation(input: {
    reviewPromptPath: string;
    reviewCommandOverride?: string[];
    commandOverride?: string[];
    model?: string;
  }): { command: string; args: string[]; promptTransport: "arg" | "stdin" } {
    return {
      ...resolveCommand(requiredCustomCommand(input.reviewCommandOverride ?? input.commandOverride), input.reviewPromptPath),
      promptTransport: "arg"
    };
  }
}

function requiredCustomCommand(command: string[] | undefined): string[] {
  if (!command) {
    throw new Error("Custom runner requires runner.command or runner.reviewCommand in .afk/config.yaml");
  }
  return command;
}

function resolveCommand(template: string[], promptPath: string): { command: string; args: string[] } {
  const resolved = resolveCommandParts(template, promptPath);
  return { command: resolved[0]!, args: resolved.slice(1) };
}

function resolveCommandParts(template: string[], promptPath: string): string[] {
  const hasPlaceholder = template.some((part) => part.includes("{prompt}"));
  const resolved = template.map((part) => part.replaceAll("{prompt}", promptPath));
  return hasPlaceholder ? resolved : [...resolved, promptPath];
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
