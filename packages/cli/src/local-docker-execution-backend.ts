import fs from "node:fs";
import path from "node:path";
import type { ExecutionBackend, ExecutionBackendInput, ExecutionBackendResult, AgentRunner, RunProgress } from "@afk-geoff/core";
import type { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import type { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { DockerWorkspaceRuntime } from "@afk-geoff/runtime-docker";
import {
  buildWorkerPrompt,
  createId,
  maybeReadOverride,
  parseJsonWithRecovery,
  workerResultSchema,
  DEFAULT_DOCKERFILE_PATH
} from "@afk-geoff/shared";
import { branchNameForWorkItem } from "@afk-geoff/adapter-local-git";
import type { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";

interface LocalDockerExecutionBackendDeps {
  repoRoot: string;
  config: ReturnType<typeof loadProjectConfig>;
  paths: ReturnType<typeof resolveProjectPaths>;
  store: SqliteStateStore;
  git: LocalGitCodeHost;
  runtime: DockerWorkspaceRuntime;
  runner: AgentRunner;
  githubToken?: string;
}

export class LocalDockerExecutionBackend implements ExecutionBackend {
  private readonly repoRoot: string;
  private readonly config: ReturnType<typeof loadProjectConfig>;
  private readonly paths: ReturnType<typeof resolveProjectPaths>;
  private readonly store: SqliteStateStore;
  private readonly git: LocalGitCodeHost;
  private readonly runtime: DockerWorkspaceRuntime;
  private readonly runner: AgentRunner;
  private readonly githubToken: string | undefined;

  public constructor(deps: LocalDockerExecutionBackendDeps) {
    this.repoRoot = deps.repoRoot;
    this.config = deps.config;
    this.paths = deps.paths;
    this.store = deps.store;
    this.git = deps.git;
    this.runtime = deps.runtime;
    this.runner = deps.runner;
    this.githubToken = deps.githubToken;
  }

  public async run(input: ExecutionBackendInput): Promise<ExecutionBackendResult> {
    // When a --detach parent pre-creates the run record, it passes the run ID via this env var.
    const detachedRunId = process.env.AFK_DETACH_RUN_ID;
    const isDetachedResume = !!detachedRunId;
    const runId = detachedRunId ?? createId("run");

    // Clear before spawning Docker so the container does not inherit it.
    if (detachedRunId) {
      delete process.env.AFK_DETACH_RUN_ID;
    }

    const branchName = branchNameForWorkItem(input.workItem.title);
    const worktreePath = path.join(this.paths.worktreesDir, runId);
    const runDir = path.join(this.paths.runsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });

    await this.git.createWorktree({
      cwd: this.repoRoot,
      branchName,
      baseBranch: this.config.baseBranch,
      path: worktreePath
    });

    if (!isDetachedResume) {
      // Foreground path: create run record and mark work item as in-progress now.
      await this.store.createRun({
        id: runId,
        workItemId: input.workItem.id,
        mode: "work",
        status: "running",
        branchName,
        worktreePath,
        runDir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await this.store.updateWorkItemStatus(input.workItem.id, "in_progress");
    }
    // Detached-resume path: run record and in-progress status were already written by the
    // --detach parent before spawning this background process.

    const progressContainerPath = "/afk-run/progress.json";
    const resultPath = "/afk-run/result.json";
    const promptPath = path.join(runDir, "prompt.md");
    const manifestPath = path.join(runDir, "manifest.json");
    const stdoutPath = path.join(runDir, "stdout.log");
    const stderrPath = path.join(runDir, "stderr.log");
    ensureRunnerHome(this.runner, runDir);
    const issueRef = await this.store.getExternalRefForEntity("work_item", input.workItem.id, "issue");
    const resolvedIssueUrl = input.issueUrl ?? issueRef?.url;
    const overrideText = maybeReadOverride(this.repoRoot, this.config.prompts?.worker);
    const prompt = buildWorkerPrompt({
      requirement: input.requirement,
      workItem: input.workItem,
      verification: input.verification,
      progressPath: progressContainerPath,
      resultPath,
      ...(resolvedIssueUrl ? { issueUrl: resolvedIssueUrl } : {}),
      ...(overrideText ? { overrideText } : {})
    });
    fs.writeFileSync(promptPath, prompt);
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          runId,
          workItemId: input.workItem.id,
          branchName,
          worktreePath
        },
        null,
        2
      )
    );

    const invocation = this.runner.buildInvocation({
      mode: "work",
      promptPath: "/afk-run/prompt.md",
      ...(this.config.runner.command ? { commandOverride: this.config.runner.command } : {})
    });
    const dockerfilePath = this.config.docker.dockerfilePath
      ? path.resolve(this.repoRoot, this.config.docker.dockerfilePath)
      : DEFAULT_DOCKERFILE_PATH;
    const buildContext = this.config.docker.dockerfilePath ? this.repoRoot : path.dirname(DEFAULT_DOCKERFILE_PATH);

    await this.runtime.ensureImage({
      cwd: this.repoRoot,
      image: this.config.docker.image,
      dockerfilePath,
      buildContext
    });

    const workerStdin = invocation.promptTransport === "stdin" ? prompt : undefined;
    const extraEnv = {
      ...runnerProcessEnv(this.runner, "/afk-run/runner-home"),
      ...(this.githubToken ? { GH_TOKEN: this.githubToken } : {})
    };

    const progressPath = path.join(runDir, "progress.json");
    writeProgress(progressPath, { phase: "starting", message: "Worker started", iteration: 0, updatedAt: new Date().toISOString() });
    const heartbeatInterval = setInterval(() => {
      try {
        const current = readProgress(progressPath);
        writeProgress(progressPath, { ...current, updatedAt: new Date().toISOString() });
      } catch {
        // ignore heartbeat errors
      }
    }, 10_000);

    let exitCode: number;
    try {
      exitCode = await this.runtime.runWork({
        image: this.config.docker.image,
        repoGitDir: path.join(this.repoRoot, ".git"),
        worktreePath,
        runDir,
        envAllowlist: this.config.runner.envAllowlist,
        extraEnv,
        command: invocation.command,
        args: invocation.args,
        ...(workerStdin === undefined ? {} : { stdin: workerStdin }),
        stdoutPath,
        stderrPath
      });
    } finally {
      clearInterval(heartbeatInterval);
    }

    const hostResultPath = path.join(runDir, "result.json");

    if (!fs.existsSync(hostResultPath)) {
      await this.store.updateWorkItemStatus(input.workItem.id, "failed");
      await this.store.updateRun(runId, { status: "failed", summary: `No result.json found (exit code ${exitCode})` });
      throw new Error(`Worker did not produce result.json for ${input.workItem.id}`);
    }

    const result = workerResultSchema.parse(parseJsonWithRecovery(fs.readFileSync(hostResultPath, "utf8")));

    if (result.status === "blocked" || result.status === "failed") {
      await this.store.updateWorkItemStatus(input.workItem.id, result.status);
      await this.store.updateRun(runId, {
        status: result.status === "failed" ? "failed" : "completed",
        summary: result.summary
      });
      return {
        status: result.status,
        summary: result.summary,
        issueComment: result.issueComment,
        hasDiff: false
      };
    }

    await this.git.commitAll({
      cwd: worktreePath,
      message: `afk: ${input.workItem.title}`
    });

    const hasDiff = await this.git.hasDiffAgainst({
      cwd: worktreePath,
      baseBranch: this.config.baseBranch
    });

    if (!hasDiff) {
      await this.store.updateWorkItemStatus(input.workItem.id, "done");
      await this.store.updateRun(runId, { status: "completed", summary: result.summary });
      return {
        status: "done",
        summary: result.summary,
        issueComment: result.issueComment,
        hasDiff: false
      };
    }

    const pullRequest = result.pr?.title && result.pr?.body
      ? {
          title: result.pr.title,
          body: result.pr.body,
          ...(result.pr.manualQa && result.pr.manualQa.length > 0 ? { manualQa: result.pr.manualQa } : {})
        }
      : undefined;

    return {
      status: "done",
      summary: result.summary,
      issueComment: result.issueComment,
      hasDiff: true,
      branchName,
      worktreePath,
      ...(pullRequest ? { pullRequest } : {})
    };
  }
}

function writeProgress(progressPath: string, progress: RunProgress): void {
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function readProgress(progressPath: string): RunProgress {
  return JSON.parse(fs.readFileSync(progressPath, "utf8")) as RunProgress;
}

function ensureRunnerHome(runner: AgentRunner, runDir: string): string {
  if (runner.kind !== "claude") {
    return runDir;
  }

  const runnerHome = path.join(runDir, "runner-home");
  fs.mkdirSync(path.join(runnerHome, ".claude"), { recursive: true });
  return runnerHome;
}

function runnerProcessEnv(runner: AgentRunner, homeDir: string): NodeJS.ProcessEnv {
  if (runner.kind !== "claude") {
    return {};
  }

  return {
    HOME: homeDir
  };
}
