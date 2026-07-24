import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
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
import { emitRunEvent, isRunEventsEnabled } from "./run-events.js";

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
    const existingDetachedRun = isDetachedResume
      ? (await this.store.listRuns()).find((run) => run.id === runId)
      : undefined;

    if (isDetachedResume && !existingDetachedRun) {
      throw new Error(`Detached run ${runId} not found`);
    }

    // Clear before spawning Docker so the container does not inherit it.
    if (detachedRunId) {
      delete process.env.AFK_DETACH_RUN_ID;
    }

    const isFollowUp = !!input.followUp;
    const branchName = input.followUp?.branchName ?? existingDetachedRun?.branchName ?? branchNameForWorkItem(input.workItem.title);
    const worktreePath = input.followUp?.worktreePath && fs.existsSync(input.followUp.worktreePath)
      ? input.followUp.worktreePath
      : existingDetachedRun?.worktreePath ?? path.join(this.paths.worktreesDir, runId);
    const runDir = existingDetachedRun?.runDir ?? path.join(this.paths.runsDir, runId);
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
    const runStartedAt = new Date().toISOString();
    const progressBase = {
      runId,
      workItemId: input.workItem.id,
      branchName,
      worktreePath,
      runDir,
      startedAt: runStartedAt
    };

    const extraEnv = {
      ...runnerProcessEnv(this.runner, path.join(runtimeRunDir, "runner-home")),
      ...(this.githubToken ? { GH_TOKEN: this.githubToken } : {})
    };

    writeProgress(progressPath, buildProgress(progressBase, {
      phase: "starting",
      message: "Worker started",
      iteration: 0,
      lastEvent: "run_started"
    }));
    emitRunEvent({ event: "run_started", runId, workItemId: input.workItem.id, branchName, worktreePath, runDir });

    let lastWorkerResult: import("@afk-geoff/shared").WorkerResult | undefined;
    let reviewIssues: string[] = [];
    const workerResults: WorkerPhaseSummary[] = [];
    const reviewResults: ReviewPhaseSummary[] = [];
    const verificationSummaries: VerificationPhaseSummary[] = [];
    const commits: CommitPhaseSummary[] = [];
    const generatedArtifacts: GeneratedArtifactSummary[] = [];
    const packageManager = await resolvePackageManager(worktreePath);
    if (packageManager.warning) {
      if (isRunEventsEnabled()) {
        emitRunEvent({
          event: "package_manager_warning",
          runId,
          workItemId: input.workItem.id,
          message: packageManager.warning
        });
      } else {
        console.warn(packageManager.warning);
      }
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

      writeProgress(progressPath, buildProgress(progressBase, {
        phase,
        message: isFollowUp && isFirstIteration ? "Follow-up agent running" : isFirstIteration ? "Work agent running" : `Fix agent running (iteration ${iteration})`,
        iteration,
        lastEvent: `${phase}_started`
      }));

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
      const headBeforeWorker = await getGitHead(worktreePath);

      const workerStdin = invocation.promptTransport === "stdin" ? prompt : undefined;
      const stdoutPath = path.join(runDir, `${phase}-stdout-${iteration}.log`);
      const stderrPath = path.join(runDir, `${phase}-stderr-${iteration}.log`);
      console.log(`[${phase}] iteration ${iteration}: worker running (logs: ${path.basename(stdoutPath)}, ${path.basename(stderrPath)})`);
      emitRunEvent({
        event: phase === "fix" ? "fix_started" : "worker_started",
        runId,
        workItemId: input.workItem.id,
        iteration,
        phase,
        command: formatInvocation(invocation.command, invocation.args),
        resultPath: path.join(runDir, `${phase}-result-${iteration}.json`)
      });
      writeProgress(progressPath, buildProgress(progressBase, {
        phase,
        message: isFollowUp && isFirstIteration ? "Follow-up agent running" : isFirstIteration ? "Work agent running" : `Fix agent running (iteration ${iteration})`,
        iteration,
        currentCommand: formatInvocation(invocation.command, invocation.args),
        currentLogPaths: { stdout: stdoutPath, stderr: stderrPath },
        lastEvent: phase === "fix" ? "fix_started" : "worker_started"
      }));
      const stopStatusTicker = startStatusTicker({
        label: `[${phase}] iteration ${iteration}`,
        progressPath,
        runDir,
        stdoutPath,
        stderrPath,
        startedAt: Date.now()
      });

      const heartbeatInterval = setInterval(() => {
        try {
          const current = readProgress(progressPath);
          const processInfo = readWorkerProcessIfExists(runDir);
          writeProgress(progressPath, {
            ...current,
            updatedAt: new Date().toISOString(),
            elapsedSeconds: secondsSince(current.startedAt ?? runStartedAt),
            ...(processInfo?.pid ? { workerPid: processInfo.pid } : {})
          });
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
        stopStatusTicker();
      }

      if (!fs.existsSync(hostResultPath)) {
        const summary = `No result.json found (exit code ${exitCode}, iteration ${iteration})`;
        await this.store.updateWorkItemStatus(input.workItem.id, "failed");
        await this.store.updateRun(runId, { status: "failed", summary });
        emitRunEvent({ event: "run_completed", runId, workItemId: input.workItem.id, status: "failed", message: summary, branchName, worktreePath, runDir });
        throw new Error(`Worker did not produce result.json for ${input.workItem.id} (iteration ${iteration})`);
      }

      let agentResult: import("@afk-geoff/shared").WorkerResult;
      try {
        agentResult = workerResultSchema.parse(parseJsonWithRecovery(fs.readFileSync(hostResultPath, "utf8")));
      } catch (err) {
        const summary = `Agent produced malformed result.json (iteration ${iteration})`;
        await this.store.updateWorkItemStatus(input.workItem.id, "failed");
        await this.store.updateRun(runId, { status: "failed", summary });
        emitRunEvent({ event: "run_completed", runId, workItemId: input.workItem.id, status: "failed", message: summary, branchName, worktreePath, runDir });
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
      emitRunEvent({
        event: "worker_completed",
        runId,
        workItemId: input.workItem.id,
        iteration,
        phase,
        status: agentResult.status,
        message: agentResult.summary,
        resultPath: phaseResultPath
      });

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
          generatedArtifacts,
          branchName,
          worktreePath
        });
        emitRunEvent({
          event: "run_completed",
          runId,
          workItemId: input.workItem.id,
          status: agentResult.status,
          message: agentResult.summary,
          branchName,
          worktreePath,
          runDir,
          finalResultPath: path.join(runDir, "final-result.json")
        });
        return {
          status: agentResult.status,
          summary: agentResult.summary,
          issueComment: agentResult.issueComment,
          hasDiff: false
        };
      }

      lastWorkerResult = agentResult;

      await recordGeneratedArtifactCleanup({
        git: this.git,
        worktreePath,
        summaries: generatedArtifacts,
        iteration,
        phase,
        stage: "post-worker"
      });
      const headBeforeAfkCommit = await getGitHead(worktreePath);
      const workerCommit = headBeforeAfkCommit !== headBeforeWorker
        ? { created: true, sha: headBeforeAfkCommit, source: "worker" as const }
        : undefined;

      // Commit changes from this iteration before running verification and review.
      const commit = await this.git.commitAll({
        cwd: worktreePath,
        message: isFollowUp && iteration === 1
          ? `afk: address PR feedback for ${input.workItem.title}`
          : iteration === 1
          ? `afk: ${input.workItem.title}`
          : `afk: ${input.workItem.title} (fix ${iteration - 1})`
      });
      if (workerCommit) {
        commits.push({ iteration, phase, ...workerCommit });
      }
      if (commit.created) {
        commits.push({ iteration, phase, created: true, source: "afk", ...(commit.sha ? { sha: commit.sha } : {}) });
      }
      if (!workerCommit && !commit.created) {
        commits.push({ iteration, phase, created: false });
      }
      const commitSummary = [
        workerCommit ? `worker commit ${workerCommit.sha}` : undefined,
        commit.created ? `afk commit ${commit.sha ?? "created"}` : undefined
      ].filter(Boolean).join("; ") || "no changes";
      console.log(`[commit] iteration ${iteration}: ${commitSummary}`);

      // ------------------------------------------------------------------
      // Verification
      // ------------------------------------------------------------------
      writeProgress(progressPath, buildProgress(progressBase, {
        phase: "verify",
        message: `Running verification (iteration ${iteration})`,
        iteration,
        lastEvent: "verification_started"
      }));
      emitRunEvent({ event: "verification_started", runId, workItemId: input.workItem.id, iteration, phase: "verify" });

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
        emitRunEvent({
          event: "verification_completed",
          runId,
          workItemId: input.workItem.id,
          iteration,
          phase: "verify",
          status: passed === verificationResults.length ? "passed" : "failed",
          message: `${passed}/${verificationResults.length} passed`
        });
      } else {
        console.log(`[verify] iteration ${iteration}: no verification commands configured`);
        emitRunEvent({
          event: "verification_completed",
          runId,
          workItemId: input.workItem.id,
          iteration,
          phase: "verify",
          status: "skipped",
          message: "no verification commands configured"
        });
      }
      await recordGeneratedArtifactCleanup({
        git: this.git,
        worktreePath,
        summaries: generatedArtifacts,
        iteration,
        phase,
        stage: "post-verification"
      });

      // ------------------------------------------------------------------
      // Review
      // ------------------------------------------------------------------
      writeProgress(progressPath, buildProgress(progressBase, {
        phase: "review",
        message: `Review agent running (iteration ${iteration})`,
        iteration,
        lastEvent: "review_started"
      }));

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
      emitRunEvent({
        event: "review_started",
        runId,
        workItemId: input.workItem.id,
        iteration,
        phase: "review",
        command: formatInvocation(reviewInvocation.command, reviewInvocation.args),
        resultPath: reviewResultPath
      });
      writeProgress(progressPath, buildProgress(progressBase, {
        phase: "review",
        message: `Review agent running (iteration ${iteration})`,
        iteration,
        currentCommand: formatInvocation(reviewInvocation.command, reviewInvocation.args),
        currentLogPaths: { stdout: reviewStdoutPath, stderr: reviewStderrPath },
        lastEvent: "review_started"
      }));
      const stopReviewStatusTicker = startStatusTicker({
        label: `[review] iteration ${iteration}`,
        progressPath,
        runDir,
        stdoutPath: reviewStdoutPath,
        stderrPath: reviewStderrPath,
        startedAt: Date.now()
      });

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
        emitRunEvent({
          event: "run_completed",
          runId,
          workItemId: input.workItem.id,
          status: "failed",
          message: `Review agent process failed (iteration ${iteration})`,
          branchName,
          worktreePath,
          runDir
        });
        return {
          status: "failed",
          summary: `Review agent process failed (iteration ${iteration})`,
          issueComment: `Review agent process failed (iteration ${iteration}): ${String(err)}`,
          hasDiff: false
        };
      } finally {
        stopReviewStatusTicker();
      }

      if (!fs.existsSync(reviewResultPath)) {
        const summary = `Review agent did not produce a verdict (exit code ${reviewExitCode}, iteration ${iteration})`;
        await this.store.updateWorkItemStatus(input.workItem.id, "failed");
        await this.store.updateRun(runId, { status: "failed", summary });
        emitRunEvent({ event: "run_completed", runId, workItemId: input.workItem.id, status: "failed", message: summary, branchName, worktreePath, runDir });
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
        emitRunEvent({ event: "run_completed", runId, workItemId: input.workItem.id, status: "failed", message: summary, branchName, worktreePath, runDir });
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
      emitRunEvent({
        event: reviewResult.verdict === "ISSUES" ? "review_issues" : "review_completed",
        runId,
        workItemId: input.workItem.id,
        iteration,
        phase: "review",
        verdict: reviewResult.verdict,
        issueCount: reviewResult.issues?.length ?? 0,
        ...(reviewResult.issues?.length ? { issues: reviewResult.issues } : {}),
        ...(reviewResult.blockerReason ? { message: reviewResult.blockerReason } : {}),
        resultPath: reviewResultPath
      });

      if (reviewResult.verdict === "PASS") {
        const verificationIssues = verificationFailureIssues(verificationResults);
        if (verificationIssues.length > 0) {
          console.log(`[verify] iteration ${iteration}: forcing fix because wrapper verification failed`);
          emitRunEvent({
            event: "verification_issues",
            runId,
            workItemId: input.workItem.id,
            iteration,
            phase: "verify",
            issueCount: verificationIssues.length,
            issues: verificationIssues
          });

          reviewIssues = verificationIssues;
          if (iteration >= MAX_ITERATIONS) {
            const capSummary = `Iteration cap (${MAX_ITERATIONS}) reached with failing verification`;
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
              generatedArtifacts,
              branchName,
              worktreePath,
              hasDiff: true,
              publishable: false,
              whyNotPublishable: verificationIssues
            });
            emitRunEvent({
              event: "run_completed",
              runId,
              workItemId: input.workItem.id,
              status: "blocked",
              message: capSummary,
              branchName,
              worktreePath,
              runDir,
              finalResultPath: path.join(runDir, "final-result.json")
            });
            return {
              status: "blocked",
              summary: capSummary,
              issueComment: `**AFK run blocked**\n\n${capSummary}\n\nPending issues:\n${issueList}`,
              hasDiff: false
            };
          }

          continue;
        }

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
          generatedArtifacts,
          branchName,
          worktreePath
        });
        emitRunEvent({
          event: "run_completed",
          runId,
          workItemId: input.workItem.id,
          status: "blocked",
          message: reason,
          branchName,
          worktreePath,
          runDir,
          finalResultPath: path.join(runDir, "final-result.json")
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
          generatedArtifacts,
          branchName,
          worktreePath
        });
        emitRunEvent({
          event: "run_completed",
          runId,
          workItemId: input.workItem.id,
          status: "blocked",
          message: capSummary,
          branchName,
          worktreePath,
          runDir,
          finalResultPath: path.join(runDir, "final-result.json")
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

    await recordGeneratedArtifactCleanup({
      git: this.git,
      worktreePath,
      summaries: generatedArtifacts,
      iteration: reviewResults.at(-1)?.iteration ?? 0,
      phase: "final",
      stage: "pre-final-diff"
    });

    const finalWorktreeStatus = readWorktreeStatus(worktreePath);
    if (!finalWorktreeStatus.clean) {
      const summary = "Run completed review but left a dirty worktree";
      await this.store.updateWorkItemStatus(input.workItem.id, "blocked");
      await this.store.updateRun(runId, { status: "completed", summary });
      writeFinalRunResult(path.join(runDir, "final-result.json"), {
        runId,
        status: "blocked",
        summary,
        workerResults,
        reviewResults,
        verificationSummaries,
        commits,
        generatedArtifacts,
        branchName,
        worktreePath,
        hasDiff: true,
        publishable: false,
        whyNotPublishable: [`Dirty worktree: ${finalWorktreeStatus.shortStatus}`]
      });
      emitRunEvent({
        event: "run_completed",
        runId,
        workItemId: input.workItem.id,
        status: "blocked",
        message: summary,
        branchName,
        worktreePath,
        runDir,
        finalResultPath: path.join(runDir, "final-result.json")
      });
      return {
        status: "blocked",
        summary,
        issueComment: `**AFK run blocked**\n\n${summary}\n\n${finalWorktreeStatus.shortStatus}`,
        hasDiff: false
      };
    }

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
        generatedArtifacts,
        branchName,
        worktreePath,
        hasDiff: false,
        publishable: false,
        whyNotPublishable: ["No changes relative to the base branch"]
      });
      emitRunEvent({
        event: "run_completed",
        runId,
        workItemId: input.workItem.id,
        status: "done",
        message: finalResult.summary,
        branchName,
        worktreePath,
        runDir,
        finalResultPath: path.join(runDir, "final-result.json")
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
      generatedArtifacts,
      branchName,
      worktreePath,
      hasDiff: true,
      publishable: true
    });
    emitRunEvent({
      event: "run_completed",
      runId,
      workItemId: input.workItem.id,
      status: "done",
      message: finalResult.summary,
      branchName,
      worktreePath,
      runDir,
      finalResultPath: path.join(runDir, "final-result.json")
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
  source?: "worker" | "afk";
}

interface GeneratedArtifactSummary {
  iteration: number;
  phase: string;
  stage: string;
  paths: string[];
}

type ProgressBase = Pick<RunProgress, "runId" | "workItemId" | "branchName" | "worktreePath" | "runDir" | "startedAt">;

interface WorktreeStatusSummary {
  clean: boolean;
  shortStatus: string;
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
  generatedArtifacts: GeneratedArtifactSummary[];
  branchName: string;
  worktreePath: string;
  hasDiff?: boolean;
  publishable?: boolean;
  whyNotPublishable?: string[];
}): void {
  const worktreeStatus = readWorktreeStatus(result.worktreePath);
  const verificationIssues = result.verificationSummaries.flatMap((summary) =>
    summary.results
      .filter((verification) => !verification.passed)
      .map((verification) => `Verification failed: ${verification.command} (exit ${verification.exitCode})`)
  );
  const whyNotPublishable = [
    ...verificationIssues,
    ...(worktreeStatus.clean ? [] : [`Dirty worktree: ${worktreeStatus.shortStatus}`]),
    ...(result.whyNotPublishable ?? [])
  ];
  const publishable = result.publishable ?? (
    result.status === "done" &&
    result.hasDiff === true &&
    worktreeStatus.clean &&
    verificationIssues.length === 0
  );
  fs.writeFileSync(
    pathname,
    JSON.stringify(
      {
        ...result,
        worktreeStatus,
        publishable,
        whyNotPublishable: whyNotPublishable.length > 0 ? [...new Set(whyNotPublishable)] : [],
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
  generatedArtifacts: GeneratedArtifactSummary[];
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

  const generatedArtifactCount = result.generatedArtifacts.reduce(
    (count, cleanup) => count + cleanup.paths.length,
    0
  );
  if (generatedArtifactCount > 0) {
    parts.push(`${generatedArtifactCount} generated artifact${generatedArtifactCount === 1 ? "" : "s"} cleaned`);
  }

  return `${result.status}: ${parts.join("; ")}`;
}

async function recordGeneratedArtifactCleanup(input: {
  git: LocalGitCodeHost;
  worktreePath: string;
  summaries: GeneratedArtifactSummary[];
  iteration: number;
  phase: string;
  stage: string;
}): Promise<void> {
  const paths = await input.git.discardGeneratedArtifacts({ cwd: input.worktreePath });
  if (paths.length === 0) {
    return;
  }

  input.summaries.push({
    iteration: input.iteration,
    phase: input.phase,
    stage: input.stage,
    paths
  });
  console.log(`[cleanup] ${input.stage}: removed generated artifact${paths.length === 1 ? "" : "s"} ${paths.join(", ")}`);
  emitRunEvent({
    event: "generated_artifacts_cleaned",
    iteration: input.iteration,
    phase: input.phase,
    paths
  });
}

function buildProgress(base: ProgressBase, progress: Omit<RunProgress, keyof ProgressBase | "updatedAt" | "elapsedSeconds">): RunProgress {
  return {
    ...base,
    ...progress,
    updatedAt: new Date().toISOString(),
    elapsedSeconds: secondsSince(base.startedAt ?? new Date().toISOString()),
    ...(base.worktreePath ? { dirtyStatus: readWorktreeStatus(base.worktreePath).shortStatus } : {})
  };
}

function formatInvocation(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function readWorktreeStatus(worktreePath: string): WorktreeStatusSummary {
  try {
    const shortStatus = execFileSync("git", ["status", "--short"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return { clean: shortStatus.length === 0, shortStatus };
  } catch {
    return { clean: false, shortStatus: "(git status unavailable)" };
  }
}

function startStatusTicker(input: {
  label: string;
  progressPath: string;
  runDir: string;
  stdoutPath: string;
  stderrPath: string;
  startedAt: number;
}): () => void {
  const intervalMs = Number(process.env.AFK_STATUS_INTERVAL_MS ?? 30_000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => {};
  }

  const interval = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - input.startedAt) / 1000);
    const progress = readProgressIfExists(input.progressPath);
    const processInfo = readWorkerProcessIfExists(input.runDir);
    const progressLabel = progress
      ? `progress: [${progress.phase}] ${progress.message}, updated ${secondsSince(progress.updatedAt)}s ago`
      : "progress: unavailable";
    const pidLabel = processInfo?.pid ? `, pid: ${processInfo.pid}` : "";
    console.log(
      `${input.label}: still running (${elapsedSeconds}s; ${progressLabel}${pidLabel}; logs: ${path.basename(input.stdoutPath)}, ${path.basename(input.stderrPath)})`
    );
  }, intervalMs);

  return () => clearInterval(interval);
}

function writeProgress(progressPath: string, progress: RunProgress): void {
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function readProgress(progressPath: string): RunProgress {
  return JSON.parse(fs.readFileSync(progressPath, "utf8")) as RunProgress;
}

function readProgressIfExists(progressPath: string): RunProgress | undefined {
  try {
    if (!fs.existsSync(progressPath)) {
      return undefined;
    }
    return readProgress(progressPath);
  } catch {
    return undefined;
  }
}

function readWorkerProcessIfExists(runDir: string): { pid?: number } | undefined {
  try {
    const processPath = path.join(runDir, "worker-process.json");
    if (!fs.existsSync(processPath)) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(processPath, "utf8")) as { pid?: number };
  } catch {
    return undefined;
  }
}

function secondsSince(isoTimestamp: string): number {
  const timestampMs = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(timestampMs)) {
    return 0;
  }
  return Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
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

async function getGitHead(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  return stdout.trim();
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

function verificationFailureIssues(results: VerificationCommandResult[]): string[] {
  return results
    .filter((result) => !result.passed)
    .map((result) => `Wrapper verification failed: ${result.command} (exit ${result.exitCode})`);
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
