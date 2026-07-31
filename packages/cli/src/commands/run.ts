import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { GitHubIssueWorkSource } from "@afk-geoff/adapter-github";
import { branchNameForWorkItem } from "@afk-geoff/adapter-local-git";
import {
  createId,
  dedupeVerificationEntries,
  deriveTitle,
  normalizeVerificationEntries,
  resolvePackageManagerContract,
  slugify,
  tagVerificationEntries,
  verificationCommands,
  type VerificationEntryInput
} from "@afk-geoff/shared";
import type { ExecutionBackendResult, Requirement, VerificationEntry } from "@afk-geoff/core";
import { attachTerminalFailure, buildFallbackSourceComment, describeRunnerModel, formatErrorMessage } from "../cli-utils.js";
import { NoOpSourceUpdater, tryPostSourceUpdate } from "../source-updater.js";
import { emitRunEvent } from "../run-events.js";
import { latestRunForWorkItem, markWorkItemRunFailed, mustGetRequirement, mustGetWorkItem, refreshRequirementStatuses } from "../store-helpers.js";
import { MarkdownFileWorkSource, resolveBriefPath } from "../file-work-source.js";
import type { CliContext, CliDependencies, DetachedRunOptions, RunOutcome } from "../types.js";

export async function runWorkItem(
  ctx: CliContext,
  workItemId: string,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  return runTrackedWorkItem(ctx, workItemId, options);
}

export async function runTrackedWorkItem(
  ctx: CliContext,
  workItemId: string,
  options: {
    verification?: VerificationEntryInput[];
    issueUrl?: string;
    requirePullRequest?: boolean;
    executionModeConfig?: { executionMode?: string; overlays?: string[]; risk?: string };
  } = {}
): Promise<RunOutcome> {
  const workItem = await mustGetWorkItem(ctx, workItemId);

  if (workItem.type !== "afk") {
    throw new Error(`Work item ${workItemId} is not AFK.`);
  }

  // Allow in_progress when this process was spawned as a detached worker by a --detach parent that
  // already set the work item status before spawning this background process.
  const isDetachedResume = !!process.env.AFK_DETACH_RUN_ID;
  const detachedOptions = isDetachedResume ? consumeDetachedRunOptionsFromEnv() : {};
  const isRunnable = workItem.status === "todo" || workItem.status === "failed" || (isDetachedResume && workItem.status === "in_progress");

  if (!isRunnable) {
    throw new Error(`Work item ${workItemId} is not runnable (current status: ${workItem.status}).`);
  }

  const requirement = await mustGetRequirement(ctx, workItem.requirementId);
  const verification = dedupeVerificationEntries(
    [
      ...tagVerificationEntries(ctx.config.verification, "project"),
      ...tagVerificationEntries([
        ...(workItem.briefVerification ?? []),
        ...(options.verification ?? []),
        ...(detachedOptions.verification ?? [])
      ], "brief")
    ]
  );
  resolvePackageManagerContract(ctx.repoRoot, verificationCommands(verification));
  const issueUrl = options.issueUrl ?? detachedOptions.issueUrl;
  const sourceUpdater = issueUrl ? ctx.sourceUpdaterFactory(issueUrl) : new NoOpSourceUpdater();
  const executionModeConfig = options.executionModeConfig ?? detachedOptions.executionModeConfig;
  let result: RecoverableExecutionResult;
  try {
    const reusableFinalization = options.requirePullRequest
      ? await tryReusePublishableFinalization(ctx, workItem.id)
      : undefined;
    if (reusableFinalization) {
      await ctx.store.updateWorkItemStatus(workItem.id, "in_progress");
      result = reusableFinalization;
    } else {
      result = await ctx.executionBackend.run({
        requirement,
        workItem,
        verification,
        ...(issueUrl ? { issueUrl } : {}),
        ...(executionModeConfig ? { executionModeConfig } : {})
      });
    }
  } catch (error) {
    const latestRun = await latestRunForWorkItem(ctx, workItem.id);
    const failureSummary = latestRun?.status === "failed" && latestRun.summary
      ? latestRun.summary
      : `Worker execution failed: ${formatErrorMessage(error)}`;
    await markWorkItemRunFailed(ctx, workItem.id, failureSummary);
    await tryPostSourceUpdate(sourceUpdater, {
      status: "failed",
      summary: failureSummary,
      issueComment: `**AFK run failed**\n\n${failureSummary}`
    });
    throw error;
  }

  if (result.status === "blocked" || result.status === "failed") {
    if (result.status === "failed") {
      await markWorkItemRunFailed(ctx, workItem.id, result.summary);
    }
    const issueComment = result.issueComment.trim() || buildFallbackSourceComment({ status: result.status, summary: result.summary });
    await tryPostSourceUpdate(sourceUpdater, { status: result.status, summary: result.summary, issueComment });
    const latestRun = await latestRunForWorkItem(ctx, workItem.id);
    return buildRunOutcome(workItem.id, latestRun, { status: result.status });
  }

  try {
    if (!result.hasDiff) {
      if (options.requirePullRequest) {
        await ctx.store.updateWorkItemStatus(workItem.id, "failed");
        const latestRun = await latestRunForWorkItem(ctx, workItem.id);
        if (latestRun) {
          await ctx.store.updateRun(latestRun.id, { status: "failed", summary: "Run completed without repo changes; no pull request could be opened" });
        }
        throw new Error(`Run completed without repo changes; no pull request could be opened for ${workItem.id}`);
      }

      const issueComment = result.issueComment.trim() || buildFallbackSourceComment({ status: "done", summary: result.summary });
      await tryPostSourceUpdate(sourceUpdater, { status: "done", summary: result.summary, issueComment });
      await refreshRequirementStatuses(ctx);
      const latestRun = await latestRunForWorkItem(ctx, workItem.id);
      return buildRunOutcome(workItem.id, latestRun, { status: "completed" });
    }

    if (ctx.resultPublisher && result.branchName && result.worktreePath) {
      const publication = await ctx.resultPublisher.publish({
        workItem,
        branchName: result.branchName,
        worktreePath: result.worktreePath,
        baseBranch: ctx.config.baseBranch,
        summary: result.summary,
        agentName: "Geoff",
        modelLabel: describeRunnerModel(ctx),
        ...(result.pullRequest ? { pullRequest: result.pullRequest } : {})
      });
      if (!publication.url) {
        throw new Error("Publisher did not return a pull request URL");
      }
      if (publication.externalRef) {
        await ctx.store.saveExternalRef(publication.externalRef);
      }
      const latestRun = await latestRunForWorkItem(ctx, workItem.id);
      await ctx.store.updateWorkItemStatus(workItem.id, "done");
      if (latestRun) {
        await ctx.store.updateRun(latestRun.id, { status: "completed", summary: result.summary });
        if (result.recovery) {
          recordRecoveryMetadata(latestRun.runDir, result.recovery);
        }
      }
      await refreshRequirementStatuses(ctx);
      const prUrl = publication.url;
      const issueComment = result.issueComment.trim() || buildFallbackSourceComment({ status: "done", summary: result.summary, ...(prUrl ? { prUrl } : {}) });
      await tryPostSourceUpdate(sourceUpdater, { status: "done", summary: result.summary, issueComment, ...(prUrl ? { prUrl } : {}) });
      return buildRunOutcome(workItem.id, latestRun, { status: "completed", ...(prUrl ? { prUrl } : {}) });
    }

    if (options.requirePullRequest) {
      await ctx.store.updateWorkItemStatus(workItem.id, "failed");
      const latestRun = await latestRunForWorkItem(ctx, workItem.id);
      if (latestRun) {
        await ctx.store.updateRun(latestRun.id, { status: "failed", summary: "Pull request was required but publishing was unavailable" });
      }
      throw new Error(`Pull request was required but GitHub publishing was unavailable for ${workItem.id}`);
    }

    const latestRun = await latestRunForWorkItem(ctx, workItem.id);
    await ctx.store.updateWorkItemStatus(workItem.id, "done");
    if (latestRun) {
      await ctx.store.updateRun(latestRun.id, { status: "completed", summary: result.summary });
    }
    await refreshRequirementStatuses(ctx);
    const issueCommentNoPr = result.issueComment.trim() || buildFallbackSourceComment({ status: "done", summary: result.summary });
    await tryPostSourceUpdate(sourceUpdater, { status: "done", summary: result.summary, issueComment: issueCommentNoPr });
    return buildRunOutcome(workItem.id, latestRun, { status: "completed" });
  } catch (error) {
    const terminalFailure = {
      category: "publishing" as const,
      message: `Post-run publication failed: ${formatErrorMessage(error)}`
    };
    await markWorkItemRunFailed(
      ctx,
      workItem.id,
      terminalFailure.message,
      terminalFailure.category
    );
    throw attachTerminalFailure(error, terminalFailure);
  }
}

interface RecoveryMetadata {
  sourceRunId: string;
  reusedStages: Array<"work" | "verification" | "review">;
  retriedStages: Array<"publishing">;
  recoveredAt: string;
}

type RecoverableExecutionResult = ExecutionBackendResult & {
  recovery?: RecoveryMetadata;
};

async function tryReusePublishableFinalization(
  ctx: CliContext,
  workItemId: string
): Promise<RecoverableExecutionResult | undefined> {
  const run = await latestRunForWorkItem(ctx, workItemId);
  if (
    !run ||
    run.status !== "failed" ||
    !run.branchName ||
    !run.worktreePath ||
    !fs.existsSync(run.worktreePath)
  ) {
    return undefined;
  }

  const finalResult = readJsonRecord(path.join(run.runDir, "final-result.json"));
  const workerResult = readJsonRecord(path.join(run.runDir, "result.json"));
  const worktreeStatus = isJsonRecord(finalResult?.worktreeStatus) ? finalResult.worktreeStatus : undefined;
  const terminalFailure = isJsonRecord(finalResult?.terminalFailure) ? finalResult.terminalFailure : undefined;
  const hasReusablePublishFailure = finalResult?.status === "failed"
    && finalResult.publishable === false
    && terminalFailure?.category === "publishing";
  if (
    !(
      (finalResult?.status === "done" && finalResult.publishable === true)
      || hasReusablePublishFailure
    ) ||
    worktreeStatus?.clean !== true ||
    !workerResult
  ) {
    return undefined;
  }

  const summary = typeof finalResult.latestWorkerSummary === "string"
    ? finalResult.latestWorkerSummary
    : typeof workerResult.summary === "string"
      ? workerResult.summary
      : "Reused reviewed implementation";
  const issueComment = typeof workerResult.issueComment === "string" ? workerResult.issueComment : "";
  const pr = isJsonRecord(workerResult.pr) ? workerResult.pr : undefined;
  const pullRequest = pr && typeof pr.title === "string" && typeof pr.body === "string"
    ? {
        title: pr.title,
        body: pr.body,
        ...(Array.isArray(pr.manualQa) && pr.manualQa.every((item) => typeof item === "string")
          ? { manualQa: pr.manualQa as string[] }
          : {})
      }
    : undefined;
  const recovery: RecoveryMetadata = {
    sourceRunId: run.id,
    reusedStages: ["work", "verification", "review"],
    retriedStages: ["publishing"],
    recoveredAt: new Date().toISOString()
  };
  emitRunEvent({
    event: "evidence_reused",
    runId: run.id,
    workItemId: run.workItemId,
    sourceRunId: recovery.sourceRunId,
    reusedStages: recovery.reusedStages,
    retriedStage: "publishing"
  });

  return {
    status: "done",
    summary,
    issueComment,
    hasDiff: true,
    branchName: run.branchName,
    worktreePath: run.worktreePath,
    ...(pullRequest ? { pullRequest } : {}),
    recovery
  };
}

function recordRecoveryMetadata(runDir: string, recovery: RecoveryMetadata): void {
  const finalResultPath = path.join(runDir, "final-result.json");
  const finalResult = readJsonRecord(finalResultPath);
  if (!finalResult) {
    return;
  }
  const terminalFailure = isJsonRecord(finalResult.terminalFailure)
    ? finalResult.terminalFailure
    : undefined;
  const terminalFailureMessage = typeof terminalFailure?.message === "string"
    ? terminalFailure.message
    : undefined;
  const { terminalFailure: _terminalFailure, ...completedFinalResult } = finalResult;
  const whyNotPublishable = Array.isArray(finalResult.whyNotPublishable)
    ? finalResult.whyNotPublishable.filter(
        (message) => typeof message === "string" && message !== terminalFailureMessage
      )
    : [];
  const publishabilityBlockers = withoutTerminalFailureBlocker(
    finalResult.publishabilityBlockers,
    terminalFailure
  );
  const evidencePacket = isJsonRecord(finalResult.evidencePacket)
    ? (() => {
        const { terminalFailure: _evidenceTerminalFailure, ...completedEvidencePacket } = finalResult.evidencePacket;
        const existingPublishability = isJsonRecord(completedEvidencePacket.publishability)
          ? completedEvidencePacket.publishability
          : {};
        return {
          ...completedEvidencePacket,
          publishability: {
            ...existingPublishability,
            publishable: true,
            blockers: withoutTerminalFailureBlocker(existingPublishability.blockers, terminalFailure)
          },
          recommendedHumanAction: "publish",
          recovery
        };
      })()
    : { recovery };
  fs.writeFileSync(
    finalResultPath,
    JSON.stringify({
      ...completedFinalResult,
      status: "done",
      publishable: true,
      whyNotPublishable,
      publishabilityBlockers,
      recovery,
      evidencePacket
    }, null, 2)
  );
}

function withoutTerminalFailureBlocker(
  value: unknown,
  terminalFailure: Record<string, unknown> | undefined
): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((blocker) => !(
    isJsonRecord(blocker)
    && blocker.category === terminalFailure?.category
    && blocker.message === terminalFailure?.message
  ));
}

function readJsonRecord(filename: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filename)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    return isJsonRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildRunOutcome(
  workItemId: string,
  run: Awaited<ReturnType<typeof latestRunForWorkItem>>,
  patch: RunOutcome = {}
): RunOutcome {
  return {
    workItemId,
    ...(run
      ? buildRunArtifactOutcome(run)
      : {}),
    ...patch
  };
}

function buildRunArtifactOutcome(run: NonNullable<Awaited<ReturnType<typeof latestRunForWorkItem>>>): RunOutcome {
  const resultPath = path.join(run.runDir, "result.json");
  const finalResultPath = path.join(run.runDir, "final-result.json");
  const finalVerdict = readFinalVerdict(finalResultPath);
  return {
    runId: run.id,
    status: run.status,
    ...(run.branchName ? { branchName: run.branchName } : {}),
    ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
    runDir: run.runDir,
    ...(fs.existsSync(resultPath) ? { resultPath } : {}),
    ...(fs.existsSync(finalResultPath) ? { finalResultPath } : {}),
    ...(finalVerdict ? { finalVerdict } : {}),
    ...(run.terminalFailure ? { terminalFailure: run.terminalFailure } : {})
  };
}

function readFinalVerdict(finalResultPath: string): string | undefined {
  if (!fs.existsSync(finalResultPath)) {
    return undefined;
  }

  try {
    const result = JSON.parse(fs.readFileSync(finalResultPath, "utf8")) as { status?: unknown };
    return typeof result.status === "string" ? result.status : undefined;
  } catch {
    return undefined;
  }
}

export async function runExecutionBriefFile(
  ctx: CliContext,
  inputPath: string,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const briefPath = resolveBriefPath(ctx.cwd, inputPath);
  const brief = await new MarkdownFileWorkSource(ctx.cwd).load(inputPath);
  return await runImportedExecutionBrief(ctx, brief, {
    sourceLabel: `Imported from ${path.basename(briefPath)}`,
    sourceSummary: `Imported from ${briefPath}`,
    printedSource: briefPath,
    requirePullRequest: options.requirePullRequest ?? false
  });
}

export async function runGitHubIssue(
  ctx: CliContext,
  issueUrl: string,
  dependencies: CliDependencies,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const githubToken = ctx.githubToken ?? await resolveGitHubTokenLocal(dependencies);

  if (!githubToken) {
    throw new Error("GitHub issue execution requires GitHub auth (`GH_TOKEN` or `gh auth login`)");
  }

  const workSource = dependencies.githubIssueWorkSourceFactory
    ? dependencies.githubIssueWorkSourceFactory(githubToken)
    : new GitHubIssueWorkSource(githubToken);
  const brief = await workSource.load(issueUrl);

  return await runImportedExecutionBrief(ctx, brief, {
    sourceLabel: `Imported from ${issueUrl}`,
    sourceSummary: `Imported from ${issueUrl}`,
    printedSource: issueUrl,
    requirePullRequest: options.requirePullRequest ?? false
  });
}

/**
 * Create the requirement and work item from an execution brief, print the import summary, and
 * return the created work item. Does not start execution.
 */
export async function importExecutionBrief(
  ctx: CliContext,
  brief: {
    requirementBody: string;
    workItemTitle: string;
    workItemBody: string;
    acceptanceCriteria: string[];
    verification: VerificationEntry[];
    issueUrl?: string;
  },
  options: {
    sourceLabel: string;
    sourceSummary: string;
    printedSource: string;
  }
): Promise<{ id: string; requirementId: string }> {
  const now = new Date().toISOString();
  const requirement: Requirement = {
    id: createId("req"),
    title: deriveTitle(brief.requirementBody),
    body: brief.requirementBody,
    status: "captured",
    createdAt: now,
    updatedAt: now
  };

  await ctx.store.createRequirement(requirement);
  const [workItem] = await ctx.store.createDraftWorkItems(
    requirement.id,
    options.sourceLabel,
    [
      {
        planKey: slugify(brief.workItemTitle) || "imported-brief",
        title: brief.workItemTitle,
        body: brief.workItemBody,
        type: "afk",
        acceptanceCriteria: brief.acceptanceCriteria,
        briefVerification: brief.verification,
        executionSummary: options.sourceSummary,
        dependencyPlanKeys: []
      }
    ]
  );

  if (!workItem) {
    throw new Error(`Failed to create work item from ${options.printedSource}`);
  }

  await ctx.store.updateRequirementStatus(requirement.id, "planned");
  await ctx.store.updateWorkItemStatus(workItem.id, "todo");
  await ctx.store.updateRequirementStatus(requirement.id, "approved");

  console.log(`Imported execution brief ${options.printedSource}`);
  console.log(`Requirement ${requirement.id}`);
  console.log(`Work item ${workItem.id}`);

  return { id: workItem.id, requirementId: requirement.id };
}

async function runImportedExecutionBrief(
  ctx: CliContext,
  brief: {
    requirementBody: string;
    workItemTitle: string;
    workItemBody: string;
    acceptanceCriteria: string[];
    verification: VerificationEntry[];
    issueUrl?: string;
    executionMode?: string;
    overlays?: string[];
    risk?: string;
  },
  options: {
    sourceLabel: string;
    sourceSummary: string;
    printedSource: string;
    requirePullRequest?: boolean;
  }
): Promise<RunOutcome> {
  const workItemRef = await importExecutionBrief(ctx, brief, options);
  const workItem = await mustGetWorkItem(ctx, workItemRef.id);

  const hasExplicitMode = brief.executionMode || brief.overlays || brief.risk;
  const executionModeConfig = hasExplicitMode
    ? {
        ...(brief.executionMode ? { executionMode: brief.executionMode } : {}),
        ...(brief.overlays ? { overlays: brief.overlays } : {}),
        ...(brief.risk ? { risk: brief.risk } : {})
      }
    : undefined;

  const runOptions: {
    verification?: VerificationEntryInput[];
    issueUrl?: string;
    requirePullRequest?: boolean;
    executionModeConfig?: { executionMode?: string; overlays?: string[]; risk?: string };
  } = {
    verification: brief.verification
  };

  if (options.requirePullRequest) {
    runOptions.requirePullRequest = true;
  }

  if (brief.issueUrl) {
    runOptions.issueUrl = brief.issueUrl;
  }

  if (executionModeConfig) {
    runOptions.executionModeConfig = executionModeConfig;
  }

  const outcome = await runTrackedWorkItem(ctx, workItem.id, runOptions);
  return {
    requirementId: workItemRef.requirementId,
    workItemId: workItem.id,
    ...outcome
  };
}

// ---------------------------------------------------------------------------
// Detached execution helpers
// ---------------------------------------------------------------------------

/**
 * Start a work item run in the background.
 *
 * The parent process pre-creates the run record and marks the work item as
 * in_progress so that `afk status` / `afk runs` show the run immediately.
 * A background subprocess is spawned (via `detachLauncher`) to do the actual
 * Docker execution; it picks up the pre-created run ID through AFK_DETACH_RUN_ID.
 */
export async function runWorkItemDetached(
  ctx: CliContext,
  workItemId: string,
  dependencies: CliDependencies,
  options: DetachedRunOptions & { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const workItem = await mustGetWorkItem(ctx, workItemId);

  if (workItem.type !== "afk") {
    throw new Error(`Work item ${workItemId} is not AFK.`);
  }

  if (workItem.status !== "todo" && workItem.status !== "failed") {
    throw new Error(`Work item ${workItemId} is not runnable (current status: ${workItem.status}).`);
  }

  const verification = dedupeVerificationEntries(normalizeVerificationEntries(options.verification ?? []));
  const runId = createId("run");
  const branchName = branchNameForWorkItem(workItem.title);
  const worktreePath = path.join(ctx.paths.worktreesDir, runId);
  const runDir = path.join(ctx.paths.runsDir, runId);
  const detachStdoutPath = path.join(runDir, "detach-stdout.log");
  const detachStderrPath = path.join(runDir, "detach-stderr.log");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(detachStdoutPath, "");
  fs.writeFileSync(detachStderrPath, "");

  await ctx.store.createRun({
    id: runId,
    workItemId: workItem.id,
    mode: "work",
    status: "running",
    branchName,
    worktreePath,
    runDir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await ctx.store.updateWorkItemStatus(workItem.id, "in_progress");

  fs.writeFileSync(
    path.join(runDir, "progress.json"),
    JSON.stringify(
      { phase: "starting", message: "Detached worker starting", iteration: 0, updatedAt: new Date().toISOString() },
      null,
      2
    )
  );

  const launchEnv: NodeJS.ProcessEnv = { ...process.env, AFK_DETACH_RUN_ID: runId };
  const detachedOptions = JSON.stringify({
    verification,
    ...(options.issueUrl ? { issueUrl: options.issueUrl } : {}),
    ...(options.executionModeConfig ? { executionModeConfig: options.executionModeConfig } : {})
  });
  launchEnv.AFK_DETACH_RUN_OPTIONS = detachedOptions;
  launchEnv.AFK_DETACH_STDOUT_PATH = detachStdoutPath;
  launchEnv.AFK_DETACH_STDERR_PATH = detachStderrPath;
  const launchArgv: string[] = [
    process.execPath,
    ...process.execArgv,
    process.argv[1] ?? "afk",
    "run",
    workItemId,
    ...(options.requirePullRequest ? ["--pr"] : [])
  ];

  const launcher = dependencies.detachLauncher ?? spawnDetachedProcess;
  let pid = 0;
  try {
    ({ pid } = launcher(launchArgv, launchEnv, ctx.repoRoot));
  } catch (error) {
    const message = `Detached launch failed: ${formatErrorMessage(error)}`;
    await markWorkItemRunFailed(ctx, workItem.id, message);
    throw new Error(message);
  }

  if (pid > 0) {
    fs.writeFileSync(
      path.join(runDir, "detach-process.json"),
      JSON.stringify({ pid, startedAt: new Date().toISOString() }, null, 2)
    );
  }

  console.log(`Run ${runId}`);
  console.log(`  pnpm afk status`);
  console.log(`  pnpm afk runs`);

  return {
    workItemId: workItem.id,
    runId,
    status: "running",
    branchName,
    worktreePath,
    runDir,
    detachLogPaths: {
      stdout: detachStdoutPath,
      stderr: detachStderrPath
    }
  };
}

export async function runExecutionBriefFileDetached(
  ctx: CliContext,
  inputPath: string,
  dependencies: CliDependencies,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const briefPath = resolveBriefPath(ctx.cwd, inputPath);
  const brief = await new MarkdownFileWorkSource(ctx.cwd).load(inputPath);
  const workItem = await importExecutionBrief(ctx, brief, {
    sourceLabel: `Imported from ${path.basename(briefPath)}`,
    sourceSummary: `Imported from ${briefPath}`,
    printedSource: briefPath
  });
  const briefModeConfig =
    brief.executionMode || brief.overlays || brief.risk
      ? {
          ...(brief.executionMode ? { executionMode: brief.executionMode } : {}),
          ...(brief.overlays ? { overlays: brief.overlays } : {}),
          ...(brief.risk ? { risk: brief.risk } : {})
        }
      : undefined;
  const outcome = await runWorkItemDetached(ctx, workItem.id, dependencies, {
    ...options,
    verification: brief.verification,
    ...(brief.issueUrl ? { issueUrl: brief.issueUrl } : {}),
    ...(briefModeConfig ? { executionModeConfig: briefModeConfig } : {})
  });
  return {
    requirementId: workItem.requirementId,
    workItemId: workItem.id,
    ...outcome
  };
}

export async function runGitHubIssueDetached(
  ctx: CliContext,
  issueUrl: string,
  dependencies: CliDependencies,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const githubToken = ctx.githubToken ?? await resolveGitHubTokenLocal(dependencies);

  if (!githubToken) {
    throw new Error("GitHub issue execution requires GitHub auth (`GH_TOKEN` or `gh auth login`)");
  }

  const workSource = dependencies.githubIssueWorkSourceFactory
    ? dependencies.githubIssueWorkSourceFactory(githubToken)
    : new GitHubIssueWorkSource(githubToken);
  const brief = await workSource.load(issueUrl);
  const workItem = await importExecutionBrief(ctx, brief, {
    sourceLabel: `Imported from ${issueUrl}`,
    sourceSummary: `Imported from ${issueUrl}`,
    printedSource: issueUrl
  });
  const issueModeConfig =
    brief.executionMode || brief.overlays || brief.risk
      ? {
          ...(brief.executionMode ? { executionMode: brief.executionMode } : {}),
          ...(brief.overlays ? { overlays: brief.overlays } : {}),
          ...(brief.risk ? { risk: brief.risk } : {})
        }
      : undefined;
  const outcome = await runWorkItemDetached(ctx, workItem.id, dependencies, {
    ...options,
    verification: brief.verification,
    ...(brief.issueUrl ? { issueUrl: brief.issueUrl } : {}),
    ...(issueModeConfig ? { executionModeConfig: issueModeConfig } : {})
  });
  return {
    requirementId: workItem.requirementId,
    workItemId: workItem.id,
    ...outcome
  };
}

// ---------------------------------------------------------------------------

function consumeDetachedRunOptionsFromEnv(): DetachedRunOptions {
  const source = process.env.AFK_DETACH_RUN_OPTIONS;
  delete process.env.AFK_DETACH_RUN_OPTIONS;

  if (!source) {
    return {};
  }

  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const maybeVerification = (parsed as { verification?: unknown }).verification;
    const maybeIssueUrl = (parsed as { issueUrl?: unknown }).issueUrl;
    const maybeModeConfig = (parsed as { executionModeConfig?: unknown }).executionModeConfig;

    const verification = Array.isArray(maybeVerification)
      ? maybeVerification.filter(isVerificationEntryInput)
      : [];
    const issueUrl = typeof maybeIssueUrl === "string" && maybeIssueUrl.trim().length > 0 ? maybeIssueUrl : undefined;
    const executionModeConfig =
      maybeModeConfig && typeof maybeModeConfig === "object"
        ? (maybeModeConfig as { executionMode?: string; overlays?: string[]; risk?: string })
        : undefined;

    return {
      verification,
      ...(issueUrl ? { issueUrl } : {}),
      ...(executionModeConfig ? { executionModeConfig } : {})
    };
  } catch {
    return {};
  }
}

function isVerificationEntryInput(value: unknown): value is VerificationEntryInput {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const command = (value as { command?: unknown }).command;
  return typeof command === "string" && command.trim().length > 0;
}

function spawnDetachedProcess(argv: string[], env: NodeJS.ProcessEnv, cwd: string): { pid: number } {
  const [cmd, ...args] = argv;

  if (!cmd) {
    return { pid: 0 };
  }

  const stdout = env.AFK_DETACH_STDOUT_PATH ? fs.openSync(env.AFK_DETACH_STDOUT_PATH, "a") : "ignore";
  const stderr = env.AFK_DETACH_STDERR_PATH ? fs.openSync(env.AFK_DETACH_STDERR_PATH, "a") : "ignore";
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", stdout, stderr],
    env,
    cwd
  });
  if (typeof stdout === "number") {
    fs.closeSync(stdout);
  }
  if (typeof stderr === "number") {
    fs.closeSync(stderr);
  }
  child.unref();
  return { pid: child.pid ?? 0 };
}

async function resolveGitHubTokenLocal(dependencies: CliDependencies): Promise<string | undefined> {
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }
  if (dependencies.githubTokenResolver) {
    return await dependencies.githubTokenResolver();
  }
  return undefined;
}
