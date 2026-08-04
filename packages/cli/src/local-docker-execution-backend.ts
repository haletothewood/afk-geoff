import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionBackend, ExecutionBackendInput, ExecutionBackendResult, AgentRunner, RunProgress, TerminalFailure, WorkspaceRuntime } from "@afk-geoff/core";
import type { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import type { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import {
  buildWorkerPrompt,
  buildFixWorkerPrompt,
  buildAutonomousReviewPrompt,
  classifyVerificationFailure,
  createId,
  formatExecutionModeResolution,
  maybeReadOverride,
  parseJsonWithRecovery,
  reviewResultSchema,
  resolveExecutionMode,
  resolvePackageManagerContract,
  verificationCommands,
  workerResultSchema,
  DEFAULT_DOCKERFILE_PATH,
  type VerificationCommandResult
} from "@afk-geoff/shared";
import { branchNameForWorkItem } from "@afk-geoff/adapter-local-git";
import type { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";
import { attachTerminalFailure, formatErrorMessage } from "./cli-utils.js";
import { emitRunEvent, isRunEventsEnabled } from "./run-events.js";
import { HOST_SIGNATURE_VERIFICATION_PENDING_MESSAGE, type EffectiveCommitSigningPolicy } from "./commit-signing-policy.js";

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
  commitSigningPolicy: EffectiveCommitSigningPolicy;
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
  private readonly commitSigningPolicy: EffectiveCommitSigningPolicy;

  public constructor(deps: LocalDockerExecutionBackendDeps) {
    this.repoRoot = deps.repoRoot;
    this.config = deps.config;
    this.paths = deps.paths;
    this.store = deps.store;
    this.git = deps.git;
    this.runtime = deps.runtime;
    this.runner = deps.runner;
    this.githubToken = deps.githubToken;
    this.commitSigningPolicy = deps.commitSigningPolicy;
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
    const verification = verificationCommands(input.verification);
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

    resolvePackageManagerContract(worktreePath, verification);

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

    if (!this.commitSigningPolicy.publishable) {
      const summary = this.commitSigningPolicy.failure?.message ?? "Commit signature policy is not satisfied";
      await this.store.updateWorkItemStatus(input.workItem.id, "blocked");
      await this.store.updateRun(runId, { status: "completed", summary });
      writeFinalRunResult(path.join(runDir, "final-result.json"), {
        runId,
        status: "blocked",
        summary,
        workerResults: [],
        reviewResults: [],
        verificationSummaries: [],
        commits: [],
        generatedArtifacts: [],
        branchName,
        worktreePath,
        baseBranch: this.config.baseBranch,
        commitSigningPolicy: this.commitSigningPolicy,
        publishable: false,
        whyNotPublishable: [summary]
      });
      emitRunEvent({
        event: "run_completed",
        runId,
        workItemId: input.workItem.id,
        stage: "run",
        attempt: 1,
        reused: false,
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
        issueComment: `**AFK run blocked by commit signature policy**\n\n${summary}\n\n${this.commitSigningPolicy.failure?.remediation ?? "Configure verified commit signing and retry."}`,
        hasDiff: false
      };
    }

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
    const runStartedAtMs = Date.now();
    const runStartedAt = new Date(runStartedAtMs).toISOString();
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
      ...(this.githubToken ? { GH_TOKEN: this.githubToken } : {}),
      ...signingEnvironment(this.commitSigningPolicy, this.config.git.signing.key)
    };

    writeProgress(progressPath, buildProgress(progressBase, {
      phase: "starting",
      message: "Worker started",
      iteration: 0,
      lastEvent: "run_started"
    }));
    emitRunEvent({
      event: "run_started",
      runId,
      workItemId: input.workItem.id,
      stage: "run",
      attempt: 1,
      reused: false,
      branchName,
      worktreePath,
      runDir
    });
    const emitRunCompletion = (
      status: "done" | "blocked" | "failed",
      message: string,
      finalResultPath: string
    ): void => {
      emitRunEvent({
        event: "run_completed",
        runId,
        workItemId: input.workItem.id,
        stage: "run",
        attempt: 1,
        reused: false,
        durationMs: Math.max(0, Date.now() - runStartedAtMs),
        status,
        message,
        branchName,
        worktreePath,
        runDir,
        finalResultPath
      });
    };

    let lastWorkerResult: import("@afk-geoff/shared").WorkerResult | undefined;
    let reviewIssues: string[] = [];
    const workerResults: WorkerPhaseSummary[] = [];
    const reviewResults: ReviewPhaseSummary[] = [];
    const verificationSummaries: VerificationPhaseSummary[] = [];
    const commits: CommitPhaseSummary[] = [];
    const generatedArtifacts: GeneratedArtifactSummary[] = [];
    let previousVerificationFailure: FailureObservation | undefined;
    let previousReviewFailure: FailureObservation | undefined;
    const finishOrchestratorFailure = async (
      summary: string,
      issueComment: string,
      reviewContractFailure?: ReviewContractFailure
    ): Promise<ExecutionBackendResult> => {
      const terminalFailure: TerminalFailure = {
        category: "orchestrator",
        message: summary
      };
      const finalResultPath = path.join(runDir, "final-result.json");
      await this.store.updateWorkItemStatus(input.workItem.id, "failed");
      await this.store.updateRun(runId, { status: "failed", summary, terminalFailure });
      try {
        writeFinalRunResult(finalResultPath, {
          runId,
          status: "failed",
          summary,
          workerResults,
          reviewResults,
          verificationSummaries,
          commits,
          generatedArtifacts,
          branchName,
          worktreePath,
          baseBranch: this.config.baseBranch,
          commitSigningPolicy: this.commitSigningPolicy,
          ...(reviewContractFailure ? { reviewContractFailure } : {}),
          publishable: false,
          whyNotPublishable: [summary],
          terminalFailure
        });
      } catch (error) {
        const artifactFailure: TerminalFailure = {
          category: "orchestrator",
          message: `Final result artifact persistence failed: ${formatErrorMessage(error)}`
        };
        await this.store.updateRun(runId, {
          status: "failed",
          summary: artifactFailure.message,
          terminalFailure: artifactFailure
        });
        throw attachTerminalFailure(error, artifactFailure);
      }
      emitRunCompletion("failed", summary, finalResultPath);
      return {
        status: "failed",
        summary,
        issueComment,
        hasDiff: false
      };
    };
    const packageManager = await resolvePackageManager(worktreePath);
    const verificationOrigins = new Map(
      input.verification.map((entry) => [entry.command, entry.origins ?? []])
    );
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
          verification,
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
          verification,
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
      const workerStartedAtMs = Date.now();
      console.log(`[${phase}] iteration ${iteration}: worker running (logs: ${path.basename(stdoutPath)}, ${path.basename(stderrPath)})`);
      const workerStartDetails = {
        runId,
        workItemId: input.workItem.id,
        attempt: iteration,
        reused: false,
        iteration,
        command: formatInvocation(invocation.command, invocation.args),
        resultPath: path.join(runDir, `${phase}-result-${iteration}.json`)
      } as const;
      if (phase === "fix") {
        emitRunEvent({ ...workerStartDetails, event: "fix_started", stage: "fix", phase: "fix" });
      } else {
        emitRunEvent({ ...workerStartDetails, event: "worker_started", stage: phase, phase });
      }
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
        const message = `Worker did not produce result.json for ${input.workItem.id} (iteration ${iteration})`;
        await finishOrchestratorFailure(
          summary,
          message
        );
        throw attachTerminalFailure(new Error(message), {
          category: "orchestrator",
          message: summary
        });
      }

      let agentResult: import("@afk-geoff/shared").WorkerResult;
      try {
        agentResult = workerResultSchema.parse(parseJsonWithRecovery(fs.readFileSync(hostResultPath, "utf8")));
      } catch (err) {
        const summary = `Agent produced malformed result.json (iteration ${iteration})`;
        const message = `Agent produced malformed result.json for ${input.workItem.id} (iteration ${iteration}): ${String(err)}`;
        await finishOrchestratorFailure(
          summary,
          message
        );
        throw attachTerminalFailure(new Error(message), {
          category: "orchestrator",
          message: summary
        });
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
        stage: phase,
        attempt: iteration,
        reused: false,
        durationMs: Math.max(0, Date.now() - workerStartedAtMs),
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
          worktreePath,
          baseBranch: this.config.baseBranch,
          commitSigningPolicy: this.commitSigningPolicy
        });
        emitRunCompletion(
          agentResult.status,
          agentResult.summary,
          path.join(runDir, "final-result.json")
        );
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
        runId,
        workItemId: input.workItem.id,
        iteration,
        phase,
        stage: "post-worker"
      });
      const headBeforeAfkCommit = await getGitHead(worktreePath);
      const workerCommit = headBeforeAfkCommit !== headBeforeWorker
        ? { created: true, sha: headBeforeAfkCommit, source: "worker" as const }
        : undefined;

      // Commit changes from this iteration before running verification and review.
      let commit: { created: boolean; sha?: string };
      try {
        commit = await this.git.commitAll({
          cwd: worktreePath,
          sign: this.commitSigningPolicy.enforced,
          ...(this.config.git.signing.key ? { signingKey: this.config.git.signing.key } : {}),
          message: isFollowUp && iteration === 1
            ? `afk: address PR feedback for ${input.workItem.title}`
            : iteration === 1
            ? `afk: ${input.workItem.title}`
            : `afk: ${input.workItem.title} (fix ${iteration - 1})`
        });
      } catch (error) {
        if (!this.commitSigningPolicy.enforced) {
          throw error;
        }

        const detail = error instanceof Error ? error.message : String(error);
        const summary = `Verified commit signing capability failed after the capability probe: ${detail}`;
        const failedSigningPolicy: EffectiveCommitSigningPolicy = {
          ...this.commitSigningPolicy,
          publishable: false,
          failure: {
            category: "environment",
            message: summary,
            remediation: "Restore access to the configured signing key or signing agent, verify a signed commit succeeds, then retry the run."
          }
        };
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
          baseBranch: this.config.baseBranch,
          commitSigningPolicy: failedSigningPolicy,
          publishable: false,
          whyNotPublishable: [summary]
        });
        emitRunCompletion("blocked", summary, path.join(runDir, "final-result.json"));
        return {
          status: "blocked",
          summary,
          issueComment: `**AFK run blocked by commit signing failure**\n\n${summary}\n\n${failedSigningPolicy.failure?.remediation}`,
          hasDiff: false
        };
      }
      if (workerCommit) {
        commits.push({ iteration, phase, ...workerCommit });
      }
      if (commit.created) {
        commits.push({ iteration, phase, created: true, source: "afk", ...(commit.sha ? { sha: commit.sha } : {}) });
      }
      if (!workerCommit && !commit.created) {
        commits.push({ iteration, phase, created: false });
      }
      const headAfterIteration = await getGitHead(worktreePath);
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
      const verificationStartedAtMs = Date.now();
      emitRunEvent({
        event: "verification_started",
        runId,
        workItemId: input.workItem.id,
        stage: "verification",
        attempt: iteration,
        reused: false,
        iteration,
        phase: "verify"
      });

      const verificationResults = await runVerificationCommands(verification, worktreePath, packageManager);
      verificationSummaries.push({
        iteration,
        results: verificationResults.map((result) => {
          const origins = verificationOrigins.get(result.command);
          return {
            command: result.command,
            passed: result.passed,
            exitCode: result.exitCode,
            ...(origins && origins.length > 0 ? { origins } : {}),
            ...(result.failureCategory ? { failureCategory: result.failureCategory } : {})
          };
        })
      });
      if (verificationResults.length > 0) {
        const passed = verificationResults.filter((result) => result.passed).length;
        console.log(`[verify] iteration ${iteration}: ${passed}/${verificationResults.length} passed`);
        emitRunEvent({
          event: "verification_completed",
          runId,
          workItemId: input.workItem.id,
          stage: "verification",
          attempt: iteration,
          reused: false,
          durationMs: Math.max(0, Date.now() - verificationStartedAtMs),
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
          stage: "verification",
          attempt: iteration,
          reused: false,
          durationMs: Math.max(0, Date.now() - verificationStartedAtMs),
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
        runId,
        workItemId: input.workItem.id,
        iteration,
        phase,
        stage: "post-verification"
      });

      const nonProductVerificationFailures = verificationResults.filter(
        (result) => !result.passed && (result.failureCategory ?? "product") !== "product"
      );
      if (nonProductVerificationFailures.length > 0) {
        const failure = nonProductVerificationFailures[0]!;
        const categoryLabel = failure.failureCategory === "environment"
          ? "environment"
          : "verification contract";
        const summary = `Run blocked by ${categoryLabel} failure: ${failure.command} (exit ${failure.exitCode})`;
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
          baseBranch: this.config.baseBranch,
          commitSigningPolicy: this.commitSigningPolicy,
          hasDiff: true,
          publishable: false
        });
        emitRunCompletion("blocked", summary, path.join(runDir, "final-result.json"));
        return {
          status: "blocked",
          summary,
          issueComment: `**AFK run blocked**\n\n${summary}`,
          hasDiff: false
        };
      }

      const productVerificationFailures = verificationResults.filter(
        (result) => !result.passed && (result.failureCategory ?? "product") === "product"
      );
      if (productVerificationFailures.length > 0) {
        const fingerprint = fingerprintVerificationFailures(productVerificationFailures);
        if (
          previousVerificationFailure?.fingerprint === fingerprint &&
          previousVerificationFailure.head === headAfterIteration
        ) {
          const repeatedFailure: RepeatedFailureSummary = {
            kind: "verification",
            fingerprint,
            firstIteration: previousVerificationFailure.iteration,
            repeatedIteration: iteration,
            unchangedHead: headAfterIteration
          };
          const summary = `Repeated verification failure on unchanged commit ${headAfterIteration.slice(0, 12)}; stopping after iteration ${iteration}`;
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
            repeatedFailure,
            branchName,
            worktreePath,
            baseBranch: this.config.baseBranch,
            commitSigningPolicy: this.commitSigningPolicy,
            hasDiff: await this.git.hasDiffAgainst({ cwd: worktreePath, baseBranch: this.config.baseBranch }),
            publishable: false
          });
          emitRunCompletion("blocked", summary, path.join(runDir, "final-result.json"));
          return {
            status: "blocked",
            summary,
            issueComment: `**AFK run blocked**\n\n${summary}`,
            hasDiff: false
          };
        }
        previousVerificationFailure = { fingerprint, head: headAfterIteration, iteration };
      } else {
        previousVerificationFailure = undefined;
      }

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
      const reviewStartedAtMs = Date.now();
      console.log(`[review] iteration ${iteration}: reviewer running (logs: ${path.basename(reviewStdoutPath)}, ${path.basename(reviewStderrPath)})`);
      emitRunEvent({
        event: "review_started",
        runId,
        workItemId: input.workItem.id,
        stage: "review",
        attempt: iteration,
        reused: false,
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
        const summary = `Review agent process failed to start (iteration ${iteration}): ${String(err)}`;
        return await finishOrchestratorFailure(summary, summary);
      } finally {
        stopReviewStatusTicker();
      }

      if (!fs.existsSync(reviewResultPath)) {
        const summary = `Review agent did not produce a verdict (exit code ${reviewExitCode}, iteration ${iteration})`;
        emitRunEvent({
          event: "review_contract_failed",
          runId,
          workItemId: input.workItem.id,
          stage: "review",
          attempt: 1,
          reused: false,
          iteration,
          phase: "review",
          failureKind: "missing",
          message: summary,
          resultPath: reviewResultPath
        });
        return await finishOrchestratorFailure(
          summary,
          `**AFK run failed**\n\n${summary}`,
          {
            kind: "missing",
            reviewedHead: headAfterIteration,
            iteration,
            attempt: 1,
            maxAttempts: 3,
            promptPath: reviewPromptPath,
            resultPath: reviewResultPath
          }
        );
      }

      let reviewResult: import("@afk-geoff/shared").ReviewResult;
      try {
        reviewResult = reviewResultSchema.parse(
          parseJsonWithRecovery(fs.readFileSync(reviewResultPath, "utf8"))
        );
      } catch {
        const kind = fs.readFileSync(reviewResultPath, "utf8").trim() ? "malformed" : "empty";
        const summary = `Review agent produced ${kind} output (iteration ${iteration})`;
        emitRunEvent({
          event: "review_contract_failed",
          runId,
          workItemId: input.workItem.id,
          stage: "review",
          attempt: 1,
          reused: false,
          iteration,
          phase: "review",
          failureKind: kind,
          message: summary,
          resultPath: reviewResultPath
        });
        return await finishOrchestratorFailure(
          summary,
          `**AFK run failed**\n\n${summary}`,
          {
            kind,
            reviewedHead: headAfterIteration,
            iteration,
            attempt: 1,
            maxAttempts: 3,
            promptPath: reviewPromptPath,
            resultPath: reviewResultPath
          }
        );
      }
      reviewResults.push({
        iteration,
        verdict: reviewResult.verdict,
        ...(reviewResult.issues && reviewResult.issues.length > 0 ? { issues: reviewResult.issues } : {}),
        ...(reviewResult.blockerReason ? { blockerReason: reviewResult.blockerReason } : {}),
        resultPath: reviewResultPath
      });
      console.log(`[review] iteration ${iteration}: ${reviewResult.verdict}${reviewResult.issues?.length ? ` (${reviewResult.issues.length} issue${reviewResult.issues.length === 1 ? "" : "s"})` : ""}`);
      const reviewCompletionDetails = {
        runId,
        workItemId: input.workItem.id,
        stage: "review",
        attempt: iteration,
        reused: false,
        durationMs: Math.max(0, Date.now() - reviewStartedAtMs),
        iteration,
        phase: "review",
        issueCount: reviewResult.issues?.length ?? 0,
        resultPath: reviewResultPath
      } as const;
      if (reviewResult.verdict === "ISSUES") {
        emitRunEvent({
          ...reviewCompletionDetails,
          event: "review_issues",
          verdict: "ISSUES",
          issueCount: reviewResult.issues?.length || 1,
          issues: reviewResult.issues?.length ? reviewResult.issues : ["Unspecified review issue"],
          ...(reviewResult.blockerReason ? { message: reviewResult.blockerReason } : {})
        });
      } else {
        emitRunEvent({
          ...reviewCompletionDetails,
          event: "review_completed",
          verdict: reviewResult.verdict,
          ...(reviewResult.issues?.length ? { issues: reviewResult.issues } : {}),
          ...(reviewResult.blockerReason ? { message: reviewResult.blockerReason } : {})
        });
      }

      if (reviewResult.verdict === "PASS") {
        previousReviewFailure = undefined;
        const verificationIssues = verificationFailureIssues(verificationResults);
        if (verificationIssues.length > 0) {
          console.log(`[verify] iteration ${iteration}: forcing fix because wrapper verification failed`);
          emitRunEvent({
            event: "verification_issues",
            runId,
            workItemId: input.workItem.id,
            stage: "verification",
            attempt: iteration,
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
              baseBranch: this.config.baseBranch,
              commitSigningPolicy: this.commitSigningPolicy,
              hasDiff: true,
              publishable: false,
              whyNotPublishable: verificationIssues
            });
            emitRunCompletion("blocked", capSummary, path.join(runDir, "final-result.json"));
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
          worktreePath,
          baseBranch: this.config.baseBranch,
          commitSigningPolicy: this.commitSigningPolicy
        });
        emitRunCompletion("blocked", reason, path.join(runDir, "final-result.json"));
        return {
          status: "blocked",
          summary: reason,
          issueComment: `**AFK run blocked**\n\n${reason}`,
          hasDiff: false
        };
      }

      // verdict === "ISSUES" — prepare for a fix iteration.
      reviewIssues = reviewResult.issues?.length ? reviewResult.issues : ["Unspecified issues found by review"];
      const reviewFingerprint = fingerprintReviewIssues(reviewIssues);
      if (
        previousReviewFailure?.fingerprint === reviewFingerprint &&
        previousReviewFailure.head === headAfterIteration
      ) {
        const repeatedFailure: RepeatedFailureSummary = {
          kind: "review",
          fingerprint: reviewFingerprint,
          firstIteration: previousReviewFailure.iteration,
          repeatedIteration: iteration,
          unchangedHead: headAfterIteration
        };
        const summary = `Repeated review failure on unchanged commit ${headAfterIteration.slice(0, 12)}; stopping after iteration ${iteration}`;
        const repeatedIssues = reviewIssues.map((issue) => `Repeated review issue: ${issue}`);
        const issueList = reviewIssues.map((issue) => `- ${issue}`).join("\n");
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
          repeatedFailure,
          branchName,
          worktreePath,
          baseBranch: this.config.baseBranch,
          commitSigningPolicy: this.commitSigningPolicy,
          hasDiff: await this.git.hasDiffAgainst({ cwd: worktreePath, baseBranch: this.config.baseBranch }),
          publishable: false,
          whyNotPublishable: repeatedIssues
        });
        emitRunCompletion("blocked", summary, path.join(runDir, "final-result.json"));
        return {
          status: "blocked",
          summary,
          issueComment: `**AFK run blocked**\n\n${summary}\n\nPending issues:\n${issueList}`,
          hasDiff: false
        };
      }
      previousReviewFailure = { fingerprint: reviewFingerprint, head: headAfterIteration, iteration };

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
          worktreePath,
          baseBranch: this.config.baseBranch,
          commitSigningPolicy: this.commitSigningPolicy
        });
        emitRunCompletion("blocked", capSummary, path.join(runDir, "final-result.json"));
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
      runId,
      workItemId: input.workItem.id,
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
        baseBranch: this.config.baseBranch,
        commitSigningPolicy: this.commitSigningPolicy,
        hasDiff: true,
        publishable: false,
        whyNotPublishable: [`Dirty worktree: ${finalWorktreeStatus.shortStatus}`]
      });
      emitRunCompletion("blocked", summary, path.join(runDir, "final-result.json"));
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
        baseBranch: this.config.baseBranch,
        commitSigningPolicy: this.commitSigningPolicy,
        hasDiff: false,
        publishable: false,
        whyNotPublishable: ["No changes relative to the base branch"]
      });
      emitRunCompletion("done", finalResult.summary, path.join(runDir, "final-result.json"));
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
      baseBranch: this.config.baseBranch,
      commitSigningPolicy: this.commitSigningPolicy,
      hasDiff: true,
      publishable: true
    });
    emitRunCompletion("done", finalResult.summary, path.join(runDir, "final-result.json"));

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
  results: Array<{
    command: string;
    passed: boolean;
    exitCode: number;
    origins?: import("@afk-geoff/core").VerificationOrigin[];
    failureCategory?: import("@afk-geoff/shared").VerificationFailureCategory;
  }>;
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

interface FailureObservation {
  fingerprint: string;
  head: string;
  iteration: number;
}

interface RepeatedFailureSummary {
  kind: "verification" | "review";
  fingerprint: string;
  firstIteration: number;
  repeatedIteration: number;
  unchangedHead: string;
}

interface ReviewContractFailure {
  kind: "missing" | "empty" | "malformed";
  reviewedHead: string;
  iteration: number;
  attempt: number;
  maxAttempts: number;
  promptPath: string;
  resultPath: string;
}

type ProgressBase = Pick<RunProgress, "runId" | "workItemId" | "branchName" | "worktreePath" | "runDir" | "startedAt">;

interface WorktreeStatusSummary {
  clean: boolean;
  shortStatus: string;
}

export interface PackageManagerResolution {
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
  repeatedFailure?: RepeatedFailureSummary;
  reviewContractFailure?: ReviewContractFailure;
  branchName: string;
  worktreePath: string;
  baseBranch?: string;
  commitSigningPolicy: EffectiveCommitSigningPolicy;
  hasDiff?: boolean;
  publishable?: boolean;
  whyNotPublishable?: string[];
  terminalFailure?: TerminalFailure;
}): void {
  const worktreeStatus = readWorktreeStatus(result.worktreePath);
  const terminalVerificationResults = latestVerificationResults(result.verificationSummaries);
  const commitSignatureEvidence = readCommitSignatureEvidence(
    result.worktreePath,
    result.baseBranch,
    result.commitSigningPolicy.enforced
  );
  const signatureIssues = result.commitSigningPolicy.enforced
    ? commitSignatureEvidence
        .filter((commit) => !commit.signed || !commit.verified)
        .map((commit) => `Commit signature verification failed for ${commit.sha}: ${commit.reason ?? (commit.signed ? "signature is unverifiable" : "commit is unsigned")}`)
    : [];
  const hostSignatureIssues = result.commitSigningPolicy.enforced && result.commitSigningPolicy.publishable && signatureIssues.length === 0
    ? [HOST_SIGNATURE_VERIFICATION_PENDING_MESSAGE]
    : [];
  const verificationIssues = terminalVerificationResults
    .filter((verification) => !verification.passed)
    .map((verification) => {
      const category = verification.failureCategory ?? "product";
      const label = category === "environment"
        ? "Environment verification"
        : category === "verification"
          ? "Verification contract"
          : "Product verification";
      return `${label} failed: ${verification.command} (exit ${verification.exitCode})`;
    });
  const whyNotPublishable = [
    ...verificationIssues,
    ...signatureIssues,
    ...hostSignatureIssues,
    ...(result.commitSigningPolicy.publishable ? [] : [result.commitSigningPolicy.failure?.message ?? "Commit signature policy is not satisfied"]),
    ...(worktreeStatus.clean ? [] : [`Dirty worktree: ${worktreeStatus.shortStatus}`]),
    ...(result.whyNotPublishable ?? [])
  ];
  const requestedPublishable = result.publishable ?? (
    result.status === "done" &&
    result.hasDiff === true &&
    worktreeStatus.clean &&
    verificationIssues.length === 0
  );
  const uniqueWhyNotPublishable = whyNotPublishable.length > 0 ? [...new Set(whyNotPublishable)] : [];
  const publishable = requestedPublishable
    && result.commitSigningPolicy.publishable
    && signatureIssues.length === 0
    && uniqueWhyNotPublishable.length === 0;
  const baseEvidencePacket = buildEvidencePacket({
    ...result,
    worktreeStatus,
    publishable,
    whyNotPublishable: uniqueWhyNotPublishable,
    changedFiles: readChangedFiles(result.worktreePath, result.baseBranch),
    commitSignatureEvidence
  });
  const evidencePacket: EvidencePacket = result.terminalFailure
    ? {
        ...baseEvidencePacket,
        terminalFailure: result.terminalFailure,
        recommendedHumanAction: "retry"
      }
    : baseEvidencePacket;
  fs.writeFileSync(
    pathname,
    JSON.stringify(
      {
        ...result,
        worktreeStatus,
        publishable,
        whyNotPublishable: uniqueWhyNotPublishable,
        publishabilityBlockers: evidencePacket.publishability.blockers,
        evidencePacket,
        commitSigningPolicy: result.commitSigningPolicy,
        commitSignatureEvidence,
        latestWorkerSummary: result.summary,
        summary: buildAggregateSummary(result)
      },
      null,
      2
    )
  );
}

interface EvidencePacket {
  changedFiles: string[];
  commits: Array<{ iteration: number; phase: string; sha?: string; source?: "worker" | "afk" }>;
  commitSigning: {
    policy: EffectiveCommitSigningPolicy;
    commits: CommitSignatureEvidence[];
    satisfied: boolean;
    hostVerification?: { verified: boolean; message?: string };
  };
  verification: {
    status: "passed" | "failed" | "skipped";
    commands: VerificationPhaseSummary["results"];
  };
  review: {
    verdict: string;
    passCount: number;
    issueCount: number;
    addressedIssueCount: number;
    remainingIssues: string[];
  };
  publishability: {
    publishable: boolean;
    blockers: Array<{ category: "product" | "verification" | "environment" | "review" | "worktree" | "publishing" | "policy"; message: string }>;
  };
  understandingBrief: {
    keyFilesChanged: string[];
    importantDesignDecisions: string[];
    inspectFirst: string[];
  };
  recommendedHumanAction: "publish" | "retry" | "narrow_scope" | "fix_environment" | "inspect";
  terminalFailure?: TerminalFailure;
}

function buildEvidencePacket(result: {
  status: string;
  summary: string;
  workerResults: WorkerPhaseSummary[];
  reviewResults: ReviewPhaseSummary[];
  verificationSummaries: VerificationPhaseSummary[];
  commits: CommitPhaseSummary[];
  generatedArtifacts: GeneratedArtifactSummary[];
  worktreeStatus: WorktreeStatusSummary;
  publishable: boolean;
  whyNotPublishable: string[];
  changedFiles: string[];
  commitSigningPolicy: EffectiveCommitSigningPolicy;
  commitSignatureEvidence: CommitSignatureEvidence[];
}): EvidencePacket {
  const verificationCommands = latestVerificationResults(result.verificationSummaries);
  const verificationStatus = verificationCommands.length === 0
    ? "skipped"
    : verificationCommands.every((command) => command.passed) ? "passed" : "failed";
  const latestReview = result.reviewResults.at(-1);
  const remainingIssues = latestReview?.verdict === "ISSUES" ? latestReview.issues ?? [] : [];
  const reviewIssueCount = result.reviewResults.reduce((count, review) => count + (review.issues?.length ?? 0), 0);
  const blockerMessages = result.whyNotPublishable.length > 0 ? result.whyNotPublishable : result.status === "blocked" ? [result.summary] : [];
  const blockers = blockerMessages.map((message) => ({
    category: classifyPublishabilityBlocker(message),
    message
  }));
  const changedFiles = result.changedFiles.slice(0, 20);

  return {
    changedFiles: result.changedFiles,
    commits: result.commits
      .filter((commit) => commit.created)
      .map((commit) => ({
        iteration: commit.iteration,
        phase: commit.phase,
        ...(commit.sha ? { sha: commit.sha } : {}),
        ...(commit.source ? { source: commit.source } : {})
      })),
    commitSigning: {
      policy: result.commitSigningPolicy,
      commits: result.commitSignatureEvidence,
      satisfied: result.commitSigningPolicy.publishable && result.commitSignatureEvidence.every((commit) => !result.commitSigningPolicy.enforced || (commit.signed && commit.verified)) && !result.commitSigningPolicy.enforced,
      ...(result.commitSigningPolicy.enforced
        ? { hostVerification: { verified: false, message: HOST_SIGNATURE_VERIFICATION_PENDING_MESSAGE } }
        : {})
    },
    verification: {
      status: verificationStatus,
      commands: verificationCommands
    },
    review: {
      verdict: latestReview?.verdict ?? "UNKNOWN",
      passCount: result.reviewResults.filter((review) => review.verdict === "PASS").length,
      issueCount: reviewIssueCount,
      addressedIssueCount: Math.max(0, reviewIssueCount - remainingIssues.length),
      remainingIssues
    },
    publishability: {
      publishable: result.publishable,
      blockers
    },
    understandingBrief: {
      keyFilesChanged: changedFiles,
      importantDesignDecisions: deriveImportantDesignDecisions(result),
      inspectFirst: changedFiles.slice(0, 5)
    },
    recommendedHumanAction: recommendHumanAction(result.publishable, blockers, latestReview?.verdict)
  };
}

function latestVerificationResults(
  summaries: VerificationPhaseSummary[]
): VerificationPhaseSummary["results"] {
  return summaries.at(-1)?.results ?? [];
}

function deriveImportantDesignDecisions(result: {
  summary: string;
  workerResults: WorkerPhaseSummary[];
  reviewResults: ReviewPhaseSummary[];
  verificationSummaries: VerificationPhaseSummary[];
}): string[] {
  const decisions = [
    result.summary,
    ...result.workerResults.slice(-2).map((worker) => worker.summary)
  ].filter((decision, index, all) => decision.length > 0 && all.indexOf(decision) === index);

  if (result.reviewResults.length > 1) {
    decisions.push(`Review loop required ${result.reviewResults.length} passes before final verdict ${result.reviewResults.at(-1)?.verdict ?? "UNKNOWN"}.`);
  }

  const verificationCount = result.verificationSummaries.reduce((count, summary) => count + summary.results.length, 0);
  if (verificationCount === 0) {
    decisions.push("No verification commands were configured for this run.");
  }

  return decisions.slice(0, 5);
}

function classifyPublishabilityBlocker(message: string): EvidencePacket["publishability"]["blockers"][number]["category"] {
  const normalized = message.toLowerCase();
  if (normalized.includes("signing capability")) {
    return "environment";
  }
  if (normalized.includes("signature") || normalized.includes("signing policy") || normalized.includes("branch-rules")) {
    return "policy";
  }
  if (normalized.includes("product verification")) {
    return "product";
  }
  if (normalized.includes("verification contract")) {
    return "verification";
  }
  if (normalized.includes("env") || normalized.includes("docker") || normalized.includes("node") || normalized.includes("module") || normalized.includes("dependency")) {
    return "environment";
  }
  if (normalized.includes("verification failed") || normalized.includes("test") || normalized.includes("typecheck")) {
    return "verification";
  }
  if (normalized.includes("review") || normalized.includes("blocked")) {
    return "review";
  }
  if (normalized.includes("dirty worktree") || normalized.includes("worktree")) {
    return "worktree";
  }
  if (normalized.includes("publish") || normalized.includes("pull request") || normalized.includes("github")) {
    return "publishing";
  }
  return "product";
}

export interface CommitSignatureEvidence {
  sha: string;
  signed: boolean;
  verified: boolean;
  reason?: string;
}

export function readCommitSignatureEvidence(worktreePath: string, baseBranch: string | undefined, enabled: boolean): CommitSignatureEvidence[] {
  if (!enabled || !baseBranch) {
    return [];
  }

  try {
    const shas = execFileSync("git", ["rev-list", "--reverse", `${baseBranch}..HEAD`], {
      cwd: worktreePath,
      encoding: "utf8"
    }).trim().split("\n").filter(Boolean);
    return shas.map((sha) => {
      const rawCommit = execFileSync("git", ["cat-file", "commit", sha], { cwd: worktreePath, encoding: "utf8" });
      const signed = /^gpgsig(?:-sha256)? /m.test(rawCommit);
      if (!signed) {
        return { sha, signed: false, verified: false };
      }
      try {
        execFileSync("git", ["verify-commit", sha], { cwd: worktreePath, stdio: "ignore" });
        return { sha, signed: true, verified: true };
      } catch {
        return { sha, signed: true, verified: false };
      }
    });
  } catch {
    return [{
      sha: "unavailable",
      signed: false,
      verified: false,
      reason: "AFK could not inspect the commit range"
    }];
  }
}

function signingEnvironment(policy: EffectiveCommitSigningPolicy, signingKey: string | undefined): NodeJS.ProcessEnv {
  if (!policy.enforced) {
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false"
    };
  }

  return {
    GIT_CONFIG_COUNT: signingKey ? "2" : "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "true",
    ...(signingKey
      ? {
          GIT_CONFIG_KEY_1: "user.signingkey",
          GIT_CONFIG_VALUE_1: signingKey
        }
      : {})
  };
}

function recommendHumanAction(
  publishable: boolean,
  blockers: EvidencePacket["publishability"]["blockers"],
  reviewVerdict: string | undefined
): EvidencePacket["recommendedHumanAction"] {
  if (publishable) {
    return "publish";
  }
  if (blockers.some((blocker) => blocker.category === "environment")) {
    return "fix_environment";
  }
  if (reviewVerdict === "ISSUES" || blockers.some((blocker) => blocker.category === "verification" || blocker.category === "review")) {
    return "retry";
  }
  if (blockers.some((blocker) => blocker.category === "product")) {
    return "narrow_scope";
  }
  return "inspect";
}

function readChangedFiles(worktreePath: string, baseBranch: string | undefined): string[] {
  if (!baseBranch) {
    return [];
  }

  try {
    return execFileSync("git", ["diff", "--name-only", baseBranch, "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
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
  runId: string;
  workItemId: string;
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
    runId: input.runId,
    workItemId: input.workItemId,
    stage: "cleanup",
    attempt: Math.max(1, input.iteration),
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

export function formatInvocation(command: string, args: string[]): string {
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

export async function resolvePackageManager(cwd: string): Promise<PackageManagerResolution> {
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

export async function runVerificationCommands(commands: string[], cwd: string, packageManager: PackageManagerResolution): Promise<VerificationCommandResult[]> {
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
      const execError = error as { code?: number | string; stdout?: string; stderr?: string };
      const exitCode = typeof execError.code === "number" ? execError.code : 1;
      const stderr = execError.stderr ?? "";
      results.push({
        command: cmd,
        exitCode,
        stdout: execError.stdout ?? "",
        stderr,
        passed: false,
        failureCategory: classifyVerificationFailure({
          exitCode,
          stderr,
          ...(typeof execError.code === "string" ? { errorCode: execError.code } : {})
        })
      });
    }
  }

  return results;
}

function verificationFailureIssues(results: VerificationCommandResult[]): string[] {
  return results
    .filter((result) => !result.passed && (result.failureCategory ?? "product") === "product")
    .map((result) => `Wrapper verification failed: ${result.command} (exit ${result.exitCode})`);
}

function fingerprintVerificationFailures(results: VerificationCommandResult[]): string {
  const failures = results
    .map((result) => [
      result.failureCategory ?? "product",
      result.command.trim(),
      String(result.exitCode),
      normalizeFailureText(result.stderr)
    ].join("\u0000"))
    .sort();
  return fingerprintFailureParts(failures);
}

function fingerprintReviewIssues(issues: string[]): string {
  return fingerprintFailureParts(issues.map(normalizeFailureText).sort());
}

function fingerprintFailureParts(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 16);
}

function normalizeFailureText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function spawnReviewProcess(
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
