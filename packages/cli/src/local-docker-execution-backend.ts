import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionBackend, ExecutionBackendInput, ExecutionBackendResult, AgentRunner, RunProgress, WorkspaceRuntime } from "@afk-geoff/core";
import type { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import type { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
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
  runtime: WorkspaceRuntime;
  runner: AgentRunner;
  githubToken?: string;
}

export class LocalDockerExecutionBackend implements ExecutionBackend {
  private readonly repoRoot: string;
  private readonly config: ReturnType<typeof loadProjectConfig>;
  private readonly paths: ReturnType<typeof resolveProjectPaths>;
  private readonly store: SqliteStateStore;
  private readonly git: LocalGitCodeHost;
  private readonly runtime: WorkspaceRuntime;
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

    const isFollowUp = !!input.followUp;
    const branchName = input.followUp?.branchName ?? branchNameForWorkItem(input.workItem.title);
    const worktreePath = input.followUp?.worktreePath && fs.existsSync(input.followUp.worktreePath)
      ? input.followUp.worktreePath
      : path.join(this.paths.worktreesDir, runId);
    const runDir = path.join(this.paths.runsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });

    if (!input.followUp?.worktreePath || !fs.existsSync(input.followUp.worktreePath)) {
      if (isFollowUp) {
        await this.git.createWorktreeFromBranch({
          cwd: this.repoRoot,
          branchName,
          path: worktreePath
        });
      } else {
        await this.git.createWorktree({
          cwd: this.repoRoot,
          branchName,
          baseBranch: this.config.baseBranch,
          path: worktreePath
        });
      }
    }

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

    const runtimeRunDir = this.runtime.runDirPath?.(runDir) ?? "/afk-run";
    const progressContainerPath = path.join(runtimeRunDir, "progress.json");
    const resultContainerPath = path.join(runtimeRunDir, "result.json");
    const hostResultPath = path.join(runDir, "result.json");
    const progressPath = path.join(runDir, "progress.json");

    const extraEnv = {
      ...runnerProcessEnv(this.runner, path.join(runtimeRunDir, "runner-home")),
      ...(this.githubToken ? { GH_TOKEN: this.githubToken } : {})
    };

    writeProgress(progressPath, { phase: "starting", message: "Worker started", iteration: 0, updatedAt: new Date().toISOString() });

    let lastWorkerResult: import("@afk-geoff/shared").WorkerResult | undefined;
    let reviewIssues: string[] = [];
    const workerResults: WorkerPhaseSummary[] = [];
    const reviewResults: ReviewPhaseSummary[] = [];
    const verificationSummaries: VerificationPhaseSummary[] = [];
    const commits: CommitPhaseSummary[] = [];
    const packageManager = await resolvePackageManager(worktreePath);
    if (packageManager.warning) {
      console.warn(packageManager.warning);
    }

    // -------------------------------------------------------------------------
    // Bounded autonomous gate loop: work → verify → review → fix → verify → ...
    // -------------------------------------------------------------------------
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const isFirstIteration = iteration === 1;
      const isFixIteration = !isFirstIteration || isFollowUp;
      const phase = isFollowUp && isFirstIteration ? "follow-up" : isFirstIteration ? "work" : "fix";

      // Ensure each iteration must produce a fresh result file.
      if (fs.existsSync(hostResultPath)) {
        fs.rmSync(hostResultPath);
      }

      if (!isFirstIteration) {
        console.log(`[fix-${iteration - 1}] ${runnerLabel}${workModel ? `, model: ${workModel}` : ""}`);
      }

      writeProgress(progressPath, {
        phase,
        message: isFollowUp && isFirstIteration ? "Follow-up agent running" : isFirstIteration ? "Work agent running" : `Fix agent running (iteration ${iteration})`,
        iteration,
        updatedAt: new Date().toISOString()
      });

      // Build the appropriate prompt for this phase.
      const promptFilename = isFollowUp && isFirstIteration ? "follow-up-prompt.md" : isFirstIteration ? "prompt.md" : `fix-prompt-${iteration}.md`;
      const promptPath = path.join(runDir, promptFilename);

      let prompt: string;
      if (!isFixIteration) {
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
          reviewIssues: isFollowUp && isFirstIteration ? input.followUp?.reviewComments ?? [] : reviewIssues,
          ...(resolvedIssueUrl ? { issueUrl: resolvedIssueUrl } : {}),
          ...(workerOverrideText ? { overrideText: workerOverrideText } : {})
        });
      }

      fs.writeFileSync(promptPath, prompt);

      const invocation = this.runner.buildInvocation({
        mode: "work",
        promptPath: path.join(runtimeRunDir, promptFilename),
        ...(this.config.runner.command ? { commandOverride: this.config.runner.command } : {}),
        ...(workModel ? { model: workModel } : {})
      });

      const workerStdin = invocation.promptTransport === "stdin" ? prompt : undefined;
      const stdoutPath = path.join(runDir, `${phase}-stdout-${iteration}.log`);
      const stderrPath = path.join(runDir, `${phase}-stderr-${iteration}.log`);
      console.log(`[${phase}] iteration ${iteration}: worker running (logs: ${path.basename(stdoutPath)}, ${path.basename(stderrPath)})`);

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
      const phaseResultPath = path.join(runDir, `${phase}-result-${iteration}.json`);
      fs.copyFileSync(hostResultPath, phaseResultPath);
      workerResults.push({
        iteration,
        phase,
        status: agentResult.status,
        summary: agentResult.summary,
        resultPath: phaseResultPath
      });
      console.log(`[${phase}] iteration ${iteration}: ${agentResult.status} - ${agentResult.summary}`);

      if (agentResult.status === "blocked" || agentResult.status === "failed") {
        await this.store.updateWorkItemStatus(input.workItem.id, agentResult.status);
        await this.store.updateRun(runId, {
          status: agentResult.status === "failed" ? "failed" : "completed",
          summary: agentResult.summary
        });
        writeFinalRunResult(path.join(runDir, "final-result.json"), {
          runId,
          status: agentResult.status,
          summary: agentResult.summary,
          workerResults,
          reviewResults,
          verificationSummaries,
          commits,
          branchName,
          worktreePath
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
      const commit = await this.git.commitAll({
        cwd: worktreePath,
        message: isFollowUp && iteration === 1
          ? `afk: address PR feedback for ${input.workItem.title}`
          : iteration === 1
          ? `afk: ${input.workItem.title}`
          : `afk: ${input.workItem.title} (fix ${iteration - 1})`
      });
      commits.push({ iteration, phase, created: commit.created, ...(commit.sha ? { sha: commit.sha } : {}) });
      console.log(`[commit] iteration ${iteration}: ${commit.created ? commit.sha ?? "created" : "no changes"}`);

      // ------------------------------------------------------------------
      // Verification
      // ------------------------------------------------------------------
      writeProgress(progressPath, {
        phase: "verify",
        message: `Running verification (iteration ${iteration})`,
        iteration,
        updatedAt: new Date().toISOString()
      });

      const verificationResults = await runVerificationCommands(input.verification, worktreePath, packageManager);
      verificationSummaries.push({
        iteration,
        results: verificationResults.map((result) => ({
          command: result.command,
          passed: result.passed,
          exitCode: result.exitCode
        }))
      });
      if (verificationResults.length > 0) {
        const passed = verificationResults.filter((result) => result.passed).length;
        console.log(`[verify] iteration ${iteration}: ${passed}/${verificationResults.length} passed`);
      } else {
        console.log(`[verify] iteration ${iteration}: no verification commands configured`);
      }

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
      console.log(`[review] iteration ${iteration}: reviewer running (logs: ${path.basename(reviewStdoutPath)}, ${path.basename(reviewStderrPath)})`);

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
      reviewResults.push({
        iteration,
        verdict: reviewResult.verdict,
        ...(reviewResult.issues && reviewResult.issues.length > 0 ? { issues: reviewResult.issues } : {}),
        ...(reviewResult.blockerReason ? { blockerReason: reviewResult.blockerReason } : {}),
        resultPath: reviewResultPath
      });
      console.log(`[review] iteration ${iteration}: ${reviewResult.verdict}${reviewResult.issues?.length ? ` (${reviewResult.issues.length} issue${reviewResult.issues.length === 1 ? "" : "s"})` : ""}`);

      if (reviewResult.verdict === "PASS") {
        // Quality gate passed — proceed to publish.
        break;
      }

      if (reviewResult.verdict === "BLOCKED") {
        const reason = reviewResult.blockerReason ?? "Review agent returned BLOCKED without a reason";
        await this.store.updateWorkItemStatus(input.workItem.id, "blocked");
        await this.store.updateRun(runId, { status: "completed", summary: reason });
        writeFinalRunResult(path.join(runDir, "final-result.json"), {
          runId,
          status: "blocked",
          summary: reason,
          workerResults,
          reviewResults,
          verificationSummaries,
          commits,
          branchName,
          worktreePath
        });
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
        writeFinalRunResult(path.join(runDir, "final-result.json"), {
          runId,
          status: "blocked",
          summary: capSummary,
          workerResults,
          reviewResults,
          verificationSummaries,
          commits,
          branchName,
          worktreePath
        });
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
      writeFinalRunResult(path.join(runDir, "final-result.json"), {
        runId,
        status: "done",
        summary: finalResult.summary,
        workerResults,
        reviewResults,
        verificationSummaries,
        commits,
        branchName,
        worktreePath,
        hasDiff: false
      });
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

    writeFinalRunResult(path.join(runDir, "final-result.json"), {
      runId,
      status: "done",
      summary: finalResult.summary,
      workerResults,
      reviewResults,
      verificationSummaries,
      commits,
      branchName,
      worktreePath,
      hasDiff: true
    });

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

interface WorkerPhaseSummary {
  iteration: number;
  phase: string;
  status: string;
  summary: string;
  resultPath: string;
}

interface ReviewPhaseSummary {
  iteration: number;
  verdict: string;
  issues?: string[];
  blockerReason?: string;
  resultPath: string;
}

interface VerificationPhaseSummary {
  iteration: number;
  results: Array<{ command: string; passed: boolean; exitCode: number }>;
}

interface CommitPhaseSummary {
  iteration: number;
  phase: string;
  created: boolean;
  sha?: string;
}

interface PackageManagerResolution {
  shellPrelude?: string;
  warning?: string;
}

function writeFinalRunResult(pathname: string, result: {
  runId: string;
  status: string;
  summary: string;
  workerResults: WorkerPhaseSummary[];
  reviewResults: ReviewPhaseSummary[];
  verificationSummaries: VerificationPhaseSummary[];
  commits: CommitPhaseSummary[];
  branchName: string;
  worktreePath: string;
  hasDiff?: boolean;
}): void {
  fs.writeFileSync(
    pathname,
    JSON.stringify(
      {
        ...result,
        latestWorkerSummary: result.summary,
        summary: buildAggregateSummary(result)
      },
      null,
      2
    )
  );
}

function buildAggregateSummary(result: {
  status: string;
  summary: string;
  workerResults: WorkerPhaseSummary[];
  reviewResults: ReviewPhaseSummary[];
  verificationSummaries: VerificationPhaseSummary[];
  commits: CommitPhaseSummary[];
}): string {
  const workerCount = result.workerResults.length;
  const reviewCount = result.reviewResults.length;
  const commitCount = result.commits.filter((commit) => commit.created).length;
  const verificationCommandCount = result.verificationSummaries.reduce(
    (count, verification) => count + verification.results.length,
    0
  );
  const issueCount = result.reviewResults.reduce(
    (count, review) => count + (review.issues?.length ?? 0),
    0
  );
  const parts = [
    result.summary,
    `${workerCount} worker phase${workerCount === 1 ? "" : "s"}`,
    `${reviewCount} review pass${reviewCount === 1 ? "" : "es"}`,
    `${commitCount} commit${commitCount === 1 ? "" : "s"}`
  ];

  if (verificationCommandCount > 0) {
    parts.push(`${verificationCommandCount} verification command${verificationCommandCount === 1 ? "" : "s"}`);
  }

  if (issueCount > 0) {
    parts.push(`${issueCount} review issue${issueCount === 1 ? "" : "s"} addressed`);
  }

  return `${result.status}: ${parts.join("; ")}`;
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

async function resolvePackageManager(cwd: string): Promise<PackageManagerResolution> {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return {};
  }

  let packageManager: string | undefined;
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { packageManager?: unknown };
    packageManager = typeof packageJson.packageManager === "string" ? packageJson.packageManager : undefined;
  } catch {
    return {};
  }

  const match = packageManager?.match(/^pnpm@([^+\s]+)(?:\+.*)?$/);
  if (!match) {
    return {};
  }

  const version = match[1]!;
  const shellPrelude = `pnpm() { corepack pnpm@${shellQuote(version)} "$@"; }`;
  const pathVersion = await getPathPnpmVersion(cwd);
  const warning = pathVersion && pathVersion !== version
    ? `[AFK] Package manager: repo declares pnpm@${version}, PATH has pnpm@${pathVersion}. Using pnpm@${version} via Corepack for verification.`
    : undefined;

  return {
    shellPrelude,
    ...(warning ? { warning } : {})
  };
}

async function getPathPnpmVersion(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("pnpm", ["--version"], { cwd, timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function runVerificationCommands(commands: string[], cwd: string, packageManager: PackageManagerResolution): Promise<VerificationCommandResult[]> {
  const results: VerificationCommandResult[] = [];

  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const shellCommand = packageManager.shellPrelude
        ? `${packageManager.shellPrelude}\n${trimmed}`
        : trimmed;
      const { stdout, stderr } = await execFileAsync("bash", ["-lc", shellCommand], {
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
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
