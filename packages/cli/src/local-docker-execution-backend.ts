import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionBackend, ExecutionBackendInput, ExecutionBackendResult, AgentRunner, RunProgress } from "@afk-geoff/core";
import type { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import type { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { DockerWorkspaceRuntime } from "@afk-geoff/runtime-docker";
import {
  buildWorkerPrompt,
  buildFixWorkerPrompt,
  buildAutonomousReviewPrompt,
  createId,
  formatExecutionModeResolution,
  maybeReadOverride,
  parseJsonWithRecovery,
  reviewResultSchema,
  resolveExecutionMode,
  workerResultSchema,
  DEFAULT_DOCKERFILE_PATH,
  type VerificationCommandResult
} from "@afk-geoff/shared";
import { branchNameForWorkItem } from "@afk-geoff/adapter-local-git";
import type { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";

const execFileAsync = promisify(execFile);

/** Hard cap on total agent iterations (1 work + up to MAX_ITERATIONS-1 fix rounds). */
const MAX_ITERATIONS = 4;

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

    // Resolve models for each phase.
    const workModel = this.config.runner.command ? undefined : this.config.runner.model;
    const reviewModel = this.config.runner.reviewCommand ? undefined
      : this.config.runner.command ? undefined
      : (this.config.runner.review?.model ?? this.config.runner.model);

    // Warn when runner.model is configured but ignored due to command override.
    if (this.config.runner.model && this.config.runner.command) {
      console.warn(
        `[AFK] Warning: runner.model (${this.config.runner.model}) is ignored because runner.command override is set`
      );
    }

    // Surface resolved runner/model to operator output.
    const runnerLabel = `runner: ${this.runner.kind}`;
    console.log(`[work] ${runnerLabel}${workModel ? `, model: ${workModel}` : ""}`);
    console.log(`[review] ${runnerLabel}${reviewModel ? `, model: ${reviewModel}` : ""}`);
    const inferenceContent = [
      input.requirement.title,
      input.requirement.body,
      input.workItem.title,
      input.workItem.body,
      ...input.workItem.acceptanceCriteria
    ].join("\n");
    const resolvedMode = resolveExecutionMode(inferenceContent, input.executionModeConfig);
    console.log(formatExecutionModeResolution(resolvedMode));

    const manifestPath = path.join(runDir, "manifest.json");
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

    ensureRunnerHome(this.runner, this.repoRoot, runDir);

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

    const issueRef = await this.store.getExternalRefForEntity("work_item", input.workItem.id, "issue");
    const resolvedIssueUrl = input.issueUrl ?? issueRef?.url;
    const workerOverrideText = maybeReadOverride(this.repoRoot, this.config.prompts?.worker);
    const reviewOverrideText = maybeReadOverride(this.repoRoot, this.config.prompts?.review);

    const progressContainerPath = "/afk-run/progress.json";
    const resultContainerPath = "/afk-run/result.json";
    const hostResultPath = path.join(runDir, "result.json");
    const progressPath = path.join(runDir, "progress.json");

    const extraEnv = {
      ...runnerProcessEnv(this.runner, "/afk-run/runner-home"),
      ...(this.githubToken ? { GH_TOKEN: this.githubToken } : {})
    };

    writeProgress(progressPath, { phase: "starting", message: "Worker started", iteration: 0, updatedAt: new Date().toISOString() });

    let lastWorkerResult: import("@afk-geoff/shared").WorkerResult | undefined;
    let reviewIssues: string[] = [];

    // -------------------------------------------------------------------------
    // Bounded autonomous gate loop: work → verify → review → fix → verify → ...
    // -------------------------------------------------------------------------
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const isFirstIteration = iteration === 1;
      const phase = isFirstIteration ? "work" : "fix";

      // Ensure each iteration must produce a fresh result file.
      if (fs.existsSync(hostResultPath)) {
        fs.rmSync(hostResultPath);
      }

      if (!isFirstIteration) {
        console.log(`[fix-${iteration - 1}] ${runnerLabel}${workModel ? `, model: ${workModel}` : ""}`);
      }

      writeProgress(progressPath, {
        phase,
        message: isFirstIteration ? "Work agent running" : `Fix agent running (iteration ${iteration})`,
        iteration,
        updatedAt: new Date().toISOString()
      });

      // Build the appropriate prompt for this phase.
      const promptFilename = isFirstIteration ? "prompt.md" : `fix-prompt-${iteration}.md`;
      const promptPath = path.join(runDir, promptFilename);

      let prompt: string;
      if (isFirstIteration) {
        prompt = buildWorkerPrompt({
          requirement: input.requirement,
          workItem: input.workItem,
          verification: input.verification,
          progressPath: progressContainerPath,
          resultPath: resultContainerPath,
          ...(resolvedIssueUrl ? { issueUrl: resolvedIssueUrl } : {}),
          ...(workerOverrideText ? { overrideText: workerOverrideText } : {}),
          executionMode: resolvedMode
        });
      } else {
        prompt = buildFixWorkerPrompt({
          requirement: input.requirement,
          workItem: input.workItem,
          verification: input.verification,
          progressPath: progressContainerPath,
          resultPath: resultContainerPath,
          reviewIssues,
          ...(resolvedIssueUrl ? { issueUrl: resolvedIssueUrl } : {}),
          ...(workerOverrideText ? { overrideText: workerOverrideText } : {})
        });
      }

      fs.writeFileSync(promptPath, prompt);

      const invocation = this.runner.buildInvocation({
        mode: "work",
        promptPath: `/afk-run/${promptFilename}`,
        ...(this.config.runner.command ? { commandOverride: this.config.runner.command } : {}),
        ...(workModel ? { model: workModel } : {})
      });

      const workerStdin = invocation.promptTransport === "stdin" ? prompt : undefined;
      const stdoutPath = path.join(runDir, `${phase}-stdout-${iteration}.log`);
      const stderrPath = path.join(runDir, `${phase}-stderr-${iteration}.log`);

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

      if (!fs.existsSync(hostResultPath)) {
        await this.store.updateWorkItemStatus(input.workItem.id, "failed");
        await this.store.updateRun(runId, {
          status: "failed",
          summary: `No result.json found (exit code ${exitCode}, iteration ${iteration})`
        });
        throw new Error(`Worker did not produce result.json for ${input.workItem.id} (iteration ${iteration})`);
      }

      let agentResult: import("@afk-geoff/shared").WorkerResult;
      try {
        agentResult = workerResultSchema.parse(parseJsonWithRecovery(fs.readFileSync(hostResultPath, "utf8")));
      } catch (err) {
        await this.store.updateWorkItemStatus(input.workItem.id, "failed");
        await this.store.updateRun(runId, {
          status: "failed",
          summary: `Agent produced malformed result.json (iteration ${iteration})`
        });
        throw new Error(`Agent produced malformed result.json for ${input.workItem.id} (iteration ${iteration}): ${String(err)}`);
      }

      if (agentResult.status === "blocked" || agentResult.status === "failed") {
        await this.store.updateWorkItemStatus(input.workItem.id, agentResult.status);
        await this.store.updateRun(runId, {
          status: agentResult.status === "failed" ? "failed" : "completed",
          summary: agentResult.summary
        });
        return {
          status: agentResult.status,
          summary: agentResult.summary,
          issueComment: agentResult.issueComment,
          hasDiff: false
        };
      }

      lastWorkerResult = agentResult;

      // Commit changes from this iteration before running verification and review.
      await this.git.commitAll({
        cwd: worktreePath,
        message: iteration === 1
          ? `afk: ${input.workItem.title}`
          : `afk: ${input.workItem.title} (fix ${iteration - 1})`
      });

      // ------------------------------------------------------------------
      // Verification
      // ------------------------------------------------------------------
      writeProgress(progressPath, {
        phase: "verify",
        message: `Running verification (iteration ${iteration})`,
        iteration,
        updatedAt: new Date().toISOString()
      });

      const verificationResults = await runVerificationCommands(input.verification, worktreePath);

      // ------------------------------------------------------------------
      // Review
      // ------------------------------------------------------------------
      writeProgress(progressPath, {
        phase: "review",
        message: `Review agent running (iteration ${iteration})`,
        iteration,
        updatedAt: new Date().toISOString()
      });

      const gitDiff = await getGitDiff(worktreePath, this.config.baseBranch);
      const reviewResultPath = path.join(runDir, `review-result-${iteration}.json`);
      const reviewPromptPath = path.join(runDir, `review-prompt-${iteration}.md`);

      const reviewPrompt = buildAutonomousReviewPrompt({
        requirement: input.requirement,
        workItem: input.workItem,
        gitDiff,
        verificationResults,
        resultPath: reviewResultPath,
        ...(reviewOverrideText ? { overrideText: reviewOverrideText } : {})
      });
      fs.writeFileSync(reviewPromptPath, reviewPrompt);

      const reviewInvocation = this.runner.buildReviewInvocation({
        reviewPromptPath,
        ...(this.config.runner.reviewCommand ? { reviewCommandOverride: this.config.runner.reviewCommand } : {}),
        ...(this.config.runner.command ? { commandOverride: this.config.runner.command } : {}),
        ...(reviewModel ? { model: reviewModel } : {})
      });

      const reviewStdin = reviewInvocation.promptTransport === "stdin" ? reviewPrompt : undefined;
      const reviewStdoutPath = path.join(runDir, `review-stdout-${iteration}.log`);
      const reviewStderrPath = path.join(runDir, `review-stderr-${iteration}.log`);

      let reviewExitCode: number;
      try {
        reviewExitCode = await spawnReviewProcess(
          reviewInvocation,
          reviewStdin,
          worktreePath,
          reviewStdoutPath,
          reviewStderrPath
        );
      } catch (err) {
        await this.store.updateWorkItemStatus(input.workItem.id, "failed");
        await this.store.updateRun(runId, {
          status: "failed",
          summary: `Review agent process failed to start (iteration ${iteration}): ${String(err)}`
        });
        return {
          status: "failed",
          summary: `Review agent process failed (iteration ${iteration})`,
          issueComment: `Review agent process failed (iteration ${iteration}): ${String(err)}`,
          hasDiff: false
        };
      }

      if (!fs.existsSync(reviewResultPath)) {
        const summary = `Review agent did not produce a verdict (exit code ${reviewExitCode}, iteration ${iteration})`;
        await this.store.updateWorkItemStatus(input.workItem.id, "failed");
        await this.store.updateRun(runId, { status: "failed", summary });
        return {
          status: "failed",
          summary,
          issueComment: `**AFK run failed**\n\n${summary}`,
          hasDiff: false
        };
      }

      let reviewResult: import("@afk-geoff/shared").ReviewResult;
      try {
        reviewResult = reviewResultSchema.parse(
          parseJsonWithRecovery(fs.readFileSync(reviewResultPath, "utf8"))
        );
      } catch {
        const summary = `Review agent produced malformed output (iteration ${iteration})`;
        await this.store.updateWorkItemStatus(input.workItem.id, "failed");
        await this.store.updateRun(runId, { status: "failed", summary });
        return {
          status: "failed",
          summary,
          issueComment: `**AFK run failed**\n\n${summary}`,
          hasDiff: false
        };
      }

      if (reviewResult.verdict === "PASS") {
        // Quality gate passed — proceed to publish.
        break;
      }

      if (reviewResult.verdict === "BLOCKED") {
        const reason = reviewResult.blockerReason ?? "Review agent returned BLOCKED without a reason";
        await this.store.updateWorkItemStatus(input.workItem.id, "blocked");
        await this.store.updateRun(runId, { status: "completed", summary: reason });
        return {
          status: "blocked",
          summary: reason,
          issueComment: `**AFK run blocked**\n\n${reason}`,
          hasDiff: false
        };
      }

      // verdict === "ISSUES" — prepare for a fix iteration.
      reviewIssues = reviewResult.issues?.length ? reviewResult.issues : ["Unspecified issues found by review"];

      if (iteration >= MAX_ITERATIONS) {
        const capSummary = `Iteration cap (${MAX_ITERATIONS}) reached without passing review`;
        const issueList = reviewIssues.map((i) => `- ${i}`).join("\n");
        await this.store.updateWorkItemStatus(input.workItem.id, "blocked");
        await this.store.updateRun(runId, { status: "completed", summary: capSummary });
        return {
          status: "blocked",
          summary: capSummary,
          issueComment: `**AFK run blocked**\n\n${capSummary}\n\nPending issues:\n${issueList}`,
          hasDiff: false
        };
      }
    }

    // The loop completed with a PASS verdict.
    const finalResult = lastWorkerResult!;

    const hasDiff = await this.git.hasDiffAgainst({
      cwd: worktreePath,
      baseBranch: this.config.baseBranch
    });

    if (!hasDiff) {
      await this.store.updateWorkItemStatus(input.workItem.id, "done");
      await this.store.updateRun(runId, { status: "completed", summary: finalResult.summary });
      return {
        status: "done",
        summary: finalResult.summary,
        issueComment: finalResult.issueComment,
        hasDiff: false
      };
    }

    const pullRequest =
      finalResult.pr?.title && finalResult.pr?.body
        ? {
            title: finalResult.pr.title,
            body: finalResult.pr.body,
            ...(finalResult.pr.manualQa && finalResult.pr.manualQa.length > 0
              ? { manualQa: finalResult.pr.manualQa }
              : {})
          }
        : undefined;

    return {
      status: "done",
      summary: finalResult.summary,
      issueComment: finalResult.issueComment,
      hasDiff: true,
      branchName,
      worktreePath,
      ...(pullRequest ? { pullRequest } : {})
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const sourceClaudeInstructions = preferredClaudeInstructionPaths.find(
    (instructionPath) => fs.existsSync(instructionPath) && fs.statSync(instructionPath).isFile()
  );

  if (sourceClaudeInstructions) {
    fs.copyFileSync(sourceClaudeInstructions, path.join(runnerHome, "CLAUDE.md"));
  }

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

async function getGitDiff(worktreePath: string, baseBranch: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", `${baseBranch}..HEAD`], {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024
    });
    if (!stdout.trim()) {
      return "(no changes relative to base branch)";
    }
    const maxLen = 100_000;
    return stdout.length > maxLen ? `${stdout.slice(0, maxLen)}\n...(diff truncated)` : stdout;
  } catch {
    return "(diff unavailable)";
  }
}

async function runVerificationCommands(commands: string[], cwd: string): Promise<VerificationCommandResult[]> {
  const results: VerificationCommandResult[] = [];

  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-lc", trimmed], {
        cwd,
        timeout: 5 * 60 * 1000
      });
      results.push({ command: cmd, exitCode: 0, stdout, stderr, passed: true });
    } catch (error) {
      const execError = error as { code?: number; stdout?: string; stderr?: string };
      results.push({
        command: cmd,
        exitCode: typeof execError.code === "number" ? execError.code : 1,
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? "",
        passed: false
      });
    }
  }

  return results;
}

function spawnReviewProcess(
  invocation: { command: string; args: string[]; promptTransport: "arg" | "stdin" },
  prompt: string | undefined,
  cwd: string,
  stdoutPath: string,
  stderrPath: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const stdoutFd = fs.openSync(stdoutPath, "w");
    const stderrFd = fs.openSync(stderrPath, "w");

    const child = spawn(invocation.command, invocation.args, {
      cwd,
      stdio: ["pipe", stdoutFd, stderrFd]
    });

    child.on("error", (err) => {
      try {
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
      } catch {
        // ignore
      }
      reject(err);
    });

    child.on("close", (code) => {
      try {
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
      } catch {
        // ignore
      }
      resolve(code ?? 1);
    });

    if (child.stdin) {
      if (invocation.promptTransport === "stdin" && prompt !== undefined) {
        child.stdin.write(prompt);
      }
      child.stdin.end();
    }
  });
}
