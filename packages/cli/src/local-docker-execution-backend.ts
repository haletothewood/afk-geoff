import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionBackend, ExecutionBackendInput, ExecutionBackendResult, AgentRunner, RunProgress } from "@afk-geoff/core";
import type { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import type { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { DockerWorkspaceRuntime } from "@afk-geoff/runtime-docker";
import {
  buildWorkerPrompt,
  buildSelfReviewPrompt,
  buildFixPrompt,
  createId,
  maybeReadOverride,
  parseJsonWithRecovery,
  workerResultSchema,
  reviewResultSchema,
  DEFAULT_DOCKERFILE_PATH
} from "@afk-geoff/shared";
import { branchNameForWorkItem } from "@afk-geoff/adapter-local-git";
import type { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";

const execFileAsync = promisify(execFile);

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
    const resultContainerPath = "/afk-run/result.json";
    const promptPath = path.join(runDir, "prompt.md");
    const manifestPath = path.join(runDir, "manifest.json");
    const stdoutPath = path.join(runDir, "stdout.log");
    const stderrPath = path.join(runDir, "stderr.log");
    ensureRunnerHome(this.runner, this.repoRoot, runDir);
    const issueRef = await this.store.getExternalRefForEntity("work_item", input.workItem.id, "issue");
    const resolvedIssueUrl = input.issueUrl ?? issueRef?.url;
    const overrideText = maybeReadOverride(this.repoRoot, this.config.prompts?.worker);
    const prompt = buildWorkerPrompt({
      requirement: input.requirement,
      workItem: input.workItem,
      verification: input.verification,
      progressPath: progressContainerPath,
      resultPath: resultContainerPath,
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

    const workModel = this.config.runner.model;
    const reviewModel = this.config.runner.review?.model ?? this.config.runner.model;
    const commandOverride = this.config.runner.command;

    const workInvocation = this.runner.buildInvocation({
      mode: "work",
      promptPath: "/afk-run/prompt.md",
      ...(commandOverride ? { commandOverride } : {}),
      ...(workModel ? { model: workModel } : {})
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

    // ── Work phase ──────────────────────────────────────────────────────────
    console.log(`[afk] work phase [${this.runner.kind}${workModel ? `, model: ${workModel}` : ""}]`);
    const workerStdin = workInvocation.promptTransport === "stdin" ? prompt : undefined;
    let exitCode: number;
    try {
      exitCode = await this.runtime.runWork({
        image: this.config.docker.image,
        repoGitDir: path.join(this.repoRoot, ".git"),
        worktreePath,
        runDir,
        envAllowlist: this.config.runner.envAllowlist,
        extraEnv,
        command: workInvocation.command,
        args: workInvocation.args,
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

    // Commit work-phase changes before review so the diff is clean.
    await this.git.commitAll({
      cwd: worktreePath,
      message: `afk: ${input.workItem.title}`
    });

    // ── Verify phase (post-work) ────────────────────────────────────────────
    console.log("[afk] verify phase");
    const postWorkVerification = await runVerificationCommands(input.verification, worktreePath);

    // ── Review phase ────────────────────────────────────────────────────────
    console.log(`[afk] review phase [${this.runner.kind}${reviewModel ? `, model: ${reviewModel}` : ""}]`);
    const gitDiff = await getGitDiff(worktreePath, this.config.baseBranch);
    const reviewOverrideText = maybeReadOverride(this.repoRoot, this.config.prompts?.review);
    const reviewResultContainerPath = "/afk-run/review-result.json";
    const reviewPromptPath = path.join(runDir, "review-prompt.md");
    const reviewPrompt = buildSelfReviewPrompt({
      requirement: input.requirement,
      workItem: input.workItem,
      gitDiff,
      verificationSummary: formatVerificationSummary(postWorkVerification),
      resultPath: reviewResultContainerPath,
      ...(reviewOverrideText ? { overrideText: reviewOverrideText } : {})
    });
    fs.writeFileSync(reviewPromptPath, reviewPrompt);

    const reviewInvocation = this.runner.buildInvocation({
      mode: "work",
      promptPath: "/afk-run/review-prompt.md",
      ...(commandOverride ? { commandOverride } : {}),
      ...(reviewModel ? { model: reviewModel } : {})
    });
    const reviewStdin = reviewInvocation.promptTransport === "stdin" ? reviewPrompt : undefined;
    const reviewStdoutPath = path.join(runDir, "review-stdout.log");
    const reviewStderrPath = path.join(runDir, "review-stderr.log");

    await this.runtime.runWork({
      image: this.config.docker.image,
      repoGitDir: path.join(this.repoRoot, ".git"),
      worktreePath,
      runDir,
      envAllowlist: this.config.runner.envAllowlist,
      extraEnv,
      command: reviewInvocation.command,
      args: reviewInvocation.args,
      ...(reviewStdin === undefined ? {} : { stdin: reviewStdin }),
      stdoutPath: reviewStdoutPath,
      stderrPath: reviewStderrPath
    });

    const hostReviewResultPath = path.join(runDir, "review-result.json");
    let reviewIssues: string[] = [];

    if (fs.existsSync(hostReviewResultPath)) {
      try {
        const reviewResult = reviewResultSchema.parse(
          parseJsonWithRecovery(fs.readFileSync(hostReviewResultPath, "utf8"))
        );
        if (reviewResult.result === "ISSUES" && reviewResult.issues && reviewResult.issues.length > 0) {
          reviewIssues = reviewResult.issues;
        }
      } catch {
        // If review result is unparseable, treat as PASS to avoid blocking the run.
        console.warn("[afk] review result could not be parsed; treating as PASS");
      }
    } else {
      // No review result produced; treat as PASS.
      console.warn("[afk] review agent did not produce review-result.json; treating as PASS");
    }

    // ── Fix phase (only if review found issues) ────────────────────────────
    if (reviewIssues.length > 0) {
      console.log(`[afk] fix phase [${this.runner.kind}${workModel ? `, model: ${workModel}` : ""}] (${reviewIssues.length} issue(s))`);
      const fixResultContainerPath = "/afk-run/fix-result.json";
      const fixProgressContainerPath = "/afk-run/fix-progress.json";
      const fixPromptPath = path.join(runDir, "fix-prompt.md");
      const fixPrompt = buildFixPrompt({
        requirement: input.requirement,
        workItem: input.workItem,
        issues: reviewIssues,
        verification: input.verification,
        progressPath: fixProgressContainerPath,
        resultPath: fixResultContainerPath,
        ...(overrideText ? { overrideText } : {})
      });
      fs.writeFileSync(fixPromptPath, fixPrompt);

      const fixInvocation = this.runner.buildInvocation({
        mode: "work",
        promptPath: "/afk-run/fix-prompt.md",
        ...(commandOverride ? { commandOverride } : {}),
        ...(workModel ? { model: workModel } : {})
      });
      const fixStdin = fixInvocation.promptTransport === "stdin" ? fixPrompt : undefined;
      const fixStdoutPath = path.join(runDir, "fix-stdout.log");
      const fixStderrPath = path.join(runDir, "fix-stderr.log");

      await this.runtime.runWork({
        image: this.config.docker.image,
        repoGitDir: path.join(this.repoRoot, ".git"),
        worktreePath,
        runDir,
        envAllowlist: this.config.runner.envAllowlist,
        extraEnv,
        command: fixInvocation.command,
        args: fixInvocation.args,
        ...(fixStdin === undefined ? {} : { stdin: fixStdin }),
        stdoutPath: fixStdoutPath,
        stderrPath: fixStderrPath
      });

      // Commit any fix-phase changes.
      await this.git.commitAll({
        cwd: worktreePath,
        message: `afk: fix review issues for ${input.workItem.title}`
      });

      // ── Verify phase (post-fix) ──────────────────────────────────────────
      console.log("[afk] verify phase (post-fix)");
      await runVerificationCommands(input.verification, worktreePath);
    }

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

function ensureRunnerHome(runner: AgentRunner, repoRoot: string, runDir: string): string {
  if (runner.kind !== "claude") {
    return runDir;
  }

  const runnerHome = path.join(runDir, "runner-home");
  const runnerClaudeDir = path.join(runnerHome, ".claude");
  fs.mkdirSync(runnerClaudeDir, { recursive: true });

  const claudeConfigDir = path.join(repoRoot, ".claude");
  if (fs.existsSync(claudeConfigDir) && fs.statSync(claudeConfigDir).isDirectory()) {
    fs.cpSync(claudeConfigDir, runnerClaudeDir, { recursive: true, force: true });
  }

  const preferredClaudeInstructionPaths = [
    path.join(repoRoot, "CLAUDE.md"),
    path.join(repoRoot, "claude.md")
  ];
  const sourceClaudeInstructions = preferredClaudeInstructionPaths.find((instructionPath) => (
    fs.existsSync(instructionPath) && fs.statSync(instructionPath).isFile()
  ));

  if (sourceClaudeInstructions) {
    fs.copyFileSync(sourceClaudeInstructions, path.join(runnerHome, "CLAUDE.md"));
  }

  return runnerHome;
}

interface VerificationCommandResult {
  command: string;
  passed: boolean;
  output: string;
}

async function runVerificationCommands(verification: string[], cwd: string): Promise<VerificationCommandResult[]> {
  const results: VerificationCommandResult[] = [];

  for (const cmd of verification) {
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", cmd], { cwd });
      results.push({ command: cmd, passed: true, output: (stdout + stderr).trim() });
    } catch (error) {
      const errWithOutput = error as { stdout?: string; stderr?: string };
      const output = ((errWithOutput.stdout ?? "") + (errWithOutput.stderr ?? "")).trim();
      results.push({ command: cmd, passed: false, output });
    }
  }

  return results;
}

function formatVerificationSummary(results: VerificationCommandResult[]): string {
  if (results.length === 0) {
    return "No verification commands configured.";
  }

  return results
    .map((r) => {
      const status = r.passed ? "PASSED" : "FAILED";
      const outputSection = r.output ? `\n${r.output}` : "";
      return `[${status}] ${r.command}${outputSection}`;
    })
    .join("\n\n");
}

async function getGitDiff(worktreePath: string, baseBranch: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", baseBranch, "HEAD"], { cwd: worktreePath });
    return stdout.trim();
  } catch {
    return "";
  }
}

function runnerProcessEnv(runner: AgentRunner, homeDir: string): NodeJS.ProcessEnv {
  if (runner.kind !== "claude") {
    return {};
  }

  return {
    HOME: homeDir
  };
}
