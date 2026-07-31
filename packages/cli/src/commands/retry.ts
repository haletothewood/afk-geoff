import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  dedupeVerificationEntries,
  parseJsonWithRecovery,
  reviewResultSchema,
  tagVerificationEntries,
  type VerificationCommandResult
} from "@afk-geoff/shared";
import { formatInvocation, resolvePackageManager, runVerificationCommands, spawnReviewProcess } from "../local-docker-execution-backend.js";
import { emitRunEvent } from "../run-events.js";
import { mustGetRequirement, mustGetWorkItem, refreshRequirementStatuses } from "../store-helpers.js";
import type { CliContext } from "../types.js";

const execFileAsync = promisify(execFile);

export interface VerificationRetryOutcome {
  runId: string;
  workItemId: string;
  status: "done" | "blocked";
  publishable: boolean;
  reusedStages: string[];
  retriedStages: string[];
  verification: {
    status: "passed" | "failed";
    commands: VerificationCommandResult[];
  };
  finalResultPath: string;
}

export interface ReviewRetryOutcome {
  runId: string;
  workItemId: string;
  status: "done" | "blocked" | "failed";
  publishable: boolean;
  reusedStages: string[];
  retriedStages: string[];
  review?: { verdict: "PASS" | "ISSUES" | "BLOCKED"; issues?: string[]; blockerReason?: string };
  reviewContractFailure?: {
    kind: "missing" | "empty" | "malformed";
    attempt: number;
    maxAttempts: number;
  };
  recovery: {
    sourceRunId: string;
    reusedStages: string[];
    retriedStages: string[];
    reviewAttempt: number;
    maxReviewAttempts: number;
    recoveredAt: string;
  };
  finalResultPath: string;
}

export async function retryRunStage(
  ctx: CliContext,
  runId: string,
  stage: "verification" | "review"
): Promise<VerificationRetryOutcome | ReviewRetryOutcome> {
  return stage === "review"
    ? await retryRunReview(ctx, runId)
    : await retryRunVerification(ctx, runId);
}

export async function retryRunVerification(
  ctx: CliContext,
  runId: string
): Promise<VerificationRetryOutcome> {
  const run = (await ctx.store.listRuns()).find((candidate) => candidate.id === runId);
  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }
  if (!run.worktreePath || !fs.existsSync(run.worktreePath)) {
    throw new Error(`Run ${runId} has no reusable worktree`);
  }

  const finalResultPath = path.join(run.runDir, "final-result.json");
  const finalResult = readJsonRecord(finalResultPath);
  if (!finalResult || finalResult.status !== "blocked") {
    throw new Error(`Run ${runId} is not eligible for verification retry: expected a blocked final result`);
  }

  const reviewResults = getRecordArray(finalResult.reviewResults);
  if (reviewResults.at(-1)?.verdict !== "PASS") {
    throw new Error(`Run ${runId} is not eligible for verification retry: no reusable PASS review`);
  }
  const repeatedFailure = isRecord(finalResult.repeatedFailure) ? finalResult.repeatedFailure : undefined;
  if (repeatedFailure?.kind !== "verification" || typeof repeatedFailure.unchangedHead !== "string") {
    throw new Error(`Run ${runId} is not eligible for verification retry: no unchanged verification failure`);
  }

  const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: run.worktreePath });
  const currentHead = headOutput.trim();
  if (currentHead !== repeatedFailure.unchangedHead) {
    throw new Error(`Run ${runId} is not eligible for verification retry: worktree HEAD changed after review`);
  }
  const { stdout: statusOutput } = await execFileAsync("git", ["status", "--porcelain"], { cwd: run.worktreePath });
  if (statusOutput.trim()) {
    throw new Error(`Run ${runId} is not eligible for verification retry: worktree is dirty`);
  }

  const previousVerification = getRecordArray(finalResult.verificationSummaries);
  const commands = [
    ...new Set(previousVerification.flatMap((summary) =>
      getRecordArray(summary.results)
        .map((result) => result.command)
        .filter((command): command is string => typeof command === "string")
    ))
  ];
  if (commands.length === 0) {
    throw new Error(`Run ${runId} has no recorded verification commands`);
  }

  const iteration = Math.max(0, ...previousVerification.map((summary) =>
    typeof summary.iteration === "number" ? summary.iteration : 0
  )) + 1;
  const recovery = {
    sourceRunId: runId,
    reusedStages: ["work", "review"],
    retriedStages: ["verification"],
    recoveredAt: new Date().toISOString()
  };
  emitRunEvent({
    event: "evidence_reused",
    runId,
    workItemId: run.workItemId,
    sourceRunId: runId,
    reusedStages: ["work", "review"],
    retriedStage: "verification"
  });

  const packageManager = await resolvePackageManager(run.worktreePath);
  const verificationStartedAtMs = Date.now();
  emitRunEvent({
    event: "verification_started",
    runId,
    workItemId: run.workItemId,
    stage: "verification",
    attempt: iteration,
    reused: false,
    iteration,
    phase: "verify"
  });
  const results = await runVerificationCommands(commands, run.worktreePath, packageManager);
  const passed = results.every((result) => result.passed);
  emitRunEvent({
    event: "verification_completed",
    runId,
    workItemId: run.workItemId,
    stage: "verification",
    attempt: iteration,
    reused: false,
    durationMs: Math.max(0, Date.now() - verificationStartedAtMs),
    iteration,
    phase: "verify",
    status: passed ? "passed" : "failed",
    message: `${results.filter((result) => result.passed).length}/${results.length} passed`
  });
  const verificationSummaries = [
    ...previousVerification,
    {
      iteration,
      recovery: true,
      results: results.map((result) => ({
        command: result.command,
        passed: result.passed,
        exitCode: result.exitCode,
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {})
      }))
    }
  ];
  const whyNotPublishable = passed ? [] : results
    .filter((result) => !result.passed)
    .map((result) => `${failureLabel(result)} failed: ${result.command} (exit ${result.exitCode})`);
  const summary = passed
    ? `Verification retry passed on reviewed commit ${currentHead.slice(0, 12)}`
    : `Verification retry failed on reviewed commit ${currentHead.slice(0, 12)}`;
  const evidencePacket = isRecord(finalResult.evidencePacket) ? finalResult.evidencePacket : {};
  const updatedEvidence = {
    ...evidencePacket,
    verification: {
      status: passed ? "passed" : "failed",
      commands: results.map((result) => ({
        command: result.command,
        passed: result.passed,
        exitCode: result.exitCode,
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {})
      }))
    },
    publishability: {
      publishable: passed,
      blockers: passed ? [] : whyNotPublishable.map((message) => ({ category: "verification", message }))
    },
    recommendedHumanAction: passed ? "publish" : "retry",
    recovery
  };
  fs.writeFileSync(finalResultPath, JSON.stringify({
    ...finalResult,
    status: passed ? "done" : "blocked",
    summary,
    verificationSummaries,
    publishable: passed,
    whyNotPublishable,
    publishabilityBlockers: updatedEvidence.publishability.blockers,
    recovery,
    evidencePacket: updatedEvidence
  }, null, 2));

  await ctx.store.updateRun(runId, { status: "completed", summary });
  await ctx.store.updateWorkItemStatus(run.workItemId, passed ? "done" : "blocked");
  await refreshRequirementStatuses(ctx);

  return {
    runId,
    workItemId: run.workItemId,
    status: passed ? "done" : "blocked",
    publishable: passed,
    reusedStages: recovery.reusedStages,
    retriedStages: recovery.retriedStages,
    verification: { status: passed ? "passed" : "failed", commands: results },
    finalResultPath
  };
}

export async function retryRunReview(
  ctx: CliContext,
  runId: string
): Promise<ReviewRetryOutcome> {
  const run = (await ctx.store.listRuns()).find((candidate) => candidate.id === runId);
  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }
  if (!run.worktreePath || !fs.existsSync(run.worktreePath)) {
    throw new Error(`Run ${runId} has no reusable worktree`);
  }

  const finalResultPath = path.join(run.runDir, "final-result.json");
  const finalResult = readJsonRecord(finalResultPath);
  const failure = finalResult && isRecord(finalResult.reviewContractFailure)
    ? finalResult.reviewContractFailure
    : undefined;
  if (!finalResult || !failure) {
    throw new Error(`Run ${runId} is not eligible for review retry: no review-contract failure`);
  }
  const reviewedHead = typeof failure.reviewedHead === "string" ? failure.reviewedHead : undefined;
  const iteration = typeof failure.iteration === "number" ? failure.iteration : undefined;
  const previousAttempt = typeof failure.attempt === "number" ? failure.attempt : undefined;
  const maxAttempts = typeof failure.maxAttempts === "number" ? failure.maxAttempts : undefined;
  const promptPath = typeof failure.promptPath === "string" ? failure.promptPath : undefined;
  const resultPath = typeof failure.resultPath === "string" ? failure.resultPath : undefined;
  if (!reviewedHead || !iteration || !previousAttempt || !maxAttempts || !promptPath || !resultPath) {
    throw new Error(`Run ${runId} is not eligible for review retry: incomplete review-contract evidence`);
  }
  if (previousAttempt >= maxAttempts) {
    throw new Error(`Run ${runId} exhausted its review retry budget (${maxAttempts} attempts)`);
  }
  if (finalResult.status !== "failed") {
    throw new Error(`Run ${runId} is not eligible for review retry: expected a recoverable failed result`);
  }
  const reviewAttempt = previousAttempt + 1;

  const latestVerification = getRecordArray(finalResult.verificationSummaries).at(-1);
  const verificationResults = getRecordArray(latestVerification?.results);
  if (verificationResults.length === 0 || verificationResults.some((result) => result.passed !== true)) {
    throw new Error(`Run ${runId} is not eligible for review retry: no reusable passing verification`);
  }
  const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: run.worktreePath });
  if (headOutput.trim() !== reviewedHead) {
    throw new Error(`Run ${runId} is not eligible for review retry: worktree HEAD changed after verification`);
  }
  const { stdout: statusOutput } = await execFileAsync("git", ["status", "--porcelain"], { cwd: run.worktreePath });
  if (statusOutput.trim()) {
    throw new Error(`Run ${runId} is not eligible for review retry: worktree is dirty`);
  }
  if (!fs.existsSync(promptPath)) {
    throw new Error(`Run ${runId} is not eligible for review retry: review prompt is unavailable`);
  }

  const prompt = fs.readFileSync(promptPath, "utf8");
  fs.rmSync(resultPath, { force: true });
  const reviewModel = ctx.config.runner.reviewCommand || ctx.config.runner.command
    ? undefined
    : (ctx.config.runner.review?.model ?? ctx.config.runner.model);
  const invocation = ctx.runner.buildReviewInvocation({
    reviewPromptPath: promptPath,
    ...(ctx.config.runner.reviewCommand ? { reviewCommandOverride: ctx.config.runner.reviewCommand } : {}),
    ...(ctx.config.runner.command ? { commandOverride: ctx.config.runner.command } : {}),
    ...(reviewModel ? { model: reviewModel } : {})
  });
  const stdoutPath = path.join(run.runDir, `review-retry-${reviewAttempt}-stdout.log`);
  const stderrPath = path.join(run.runDir, `review-retry-${reviewAttempt}-stderr.log`);
  const recovery = {
    sourceRunId: runId,
    reusedStages: ["work", "verification"],
    retriedStages: ["review"],
    reviewAttempt,
    maxReviewAttempts: maxAttempts,
    recoveredAt: new Date().toISOString()
  };
  emitRunEvent({
    event: "evidence_reused",
    runId,
    workItemId: run.workItemId,
    sourceRunId: runId,
    reusedStages: ["work", "verification"],
    retriedStage: "review"
  });
  emitRunEvent({
    event: "review_started",
    runId,
    workItemId: run.workItemId,
    stage: "review",
    attempt: reviewAttempt,
    reused: false,
    iteration,
    phase: "review",
    command: formatInvocation(invocation.command, invocation.args),
    resultPath
  });
  const startedAt = Date.now();
  const exitCode = await spawnReviewProcess(
    invocation,
    invocation.promptTransport === "stdin" ? prompt : undefined,
    run.worktreePath,
    stdoutPath,
    stderrPath
  );

  if (!fs.existsSync(resultPath)) {
    return await persistReviewContractRetryFailure({
      ctx, run, finalResult, finalResultPath, failure, recovery, kind: "missing",
      summary: `Review agent did not produce a verdict (exit code ${exitCode}, review attempt ${reviewAttempt})`
    });
  }

  let reviewResult: ReturnType<typeof reviewResultSchema.parse>;
  try {
    reviewResult = reviewResultSchema.parse(parseJsonWithRecovery(fs.readFileSync(resultPath, "utf8")));
  } catch {
    const kind = fs.readFileSync(resultPath, "utf8").trim() ? "malformed" : "empty";
    return await persistReviewContractRetryFailure({
      ctx, run, finalResult, finalResultPath, failure, recovery, kind,
      summary: `Review agent produced ${kind} output (review attempt ${reviewAttempt})`
    });
  }

  const reviewResults = [
    ...getRecordArray(finalResult.reviewResults),
    {
      iteration,
      attempt: reviewAttempt,
      recovery: true,
      verdict: reviewResult.verdict,
      ...(reviewResult.issues?.length ? { issues: reviewResult.issues } : {}),
      ...(reviewResult.blockerReason ? { blockerReason: reviewResult.blockerReason } : {}),
      resultPath
    }
  ];
  const passed = reviewResult.verdict === "PASS";
  const summary = passed
    ? `Review retry passed on verified commit ${reviewedHead.slice(0, 12)}`
    : reviewResult.blockerReason ?? `Review retry returned ${reviewResult.verdict} on commit ${reviewedHead.slice(0, 12)}`;
  const whyNotPublishable = passed
    ? []
    : reviewResult.issues?.length
      ? reviewResult.issues.map((issue) => `Review issue: ${issue}`)
      : [summary];
  const previousEvidence = isRecord(finalResult.evidencePacket) ? finalResult.evidencePacket : {};
  const { terminalFailure: _evidenceFailure, ...evidenceWithoutFailure } = previousEvidence;
  const reviewEvidence = summarizeReviewEvidence(reviewResults);
  const updatedEvidence = {
    ...evidenceWithoutFailure,
    review: reviewEvidence,
    publishability: {
      publishable: passed,
      blockers: whyNotPublishable.map((message) => ({ category: "review", message }))
    },
    recommendedHumanAction: passed ? "publish" : "retry",
    recovery
  };
  const { terminalFailure: _terminalFailure, reviewContractFailure: _reviewContractFailure, ...reusableResult } = finalResult;
  fs.writeFileSync(finalResultPath, JSON.stringify({
    ...reusableResult,
    status: passed ? "done" : "blocked",
    summary,
    reviewResults,
    publishable: passed,
    whyNotPublishable,
    publishabilityBlockers: updatedEvidence.publishability.blockers,
    recovery,
    evidencePacket: updatedEvidence
  }, null, 2));
  emitRunEvent({
    event: passed ? "review_completed" : reviewResult.verdict === "ISSUES" ? "review_issues" : "review_completed",
    runId,
    workItemId: run.workItemId,
    stage: "review",
    attempt: reviewAttempt,
    reused: false,
    durationMs: Math.max(0, Date.now() - startedAt),
    iteration,
    phase: "review",
    verdict: reviewResult.verdict,
    issueCount: reviewResult.issues?.length ?? (reviewResult.verdict === "ISSUES" ? 1 : 0),
    ...(reviewResult.verdict === "ISSUES"
      ? { issues: reviewResult.issues?.length ? reviewResult.issues : ["Unspecified review issue"] }
      : reviewResult.issues?.length ? { issues: reviewResult.issues } : {}),
    ...(reviewResult.blockerReason ? { message: reviewResult.blockerReason } : {}),
    resultPath
  } as Parameters<typeof emitRunEvent>[0]);
  await ctx.store.updateRun(runId, { status: "completed", summary });
  await ctx.store.updateWorkItemStatus(run.workItemId, passed ? "done" : "blocked");
  await refreshRequirementStatuses(ctx);

  if (reviewResult.verdict === "ISSUES") {
    return await continueAfterReviewIssues(ctx, run, reviewResult.issues?.length
      ? reviewResult.issues
      : ["Unspecified review issue"], recovery);
  }

  return {
    runId,
    workItemId: run.workItemId,
    status: passed ? "done" : "blocked",
    publishable: passed,
    reusedStages: recovery.reusedStages,
    retriedStages: recovery.retriedStages,
    review: {
      verdict: reviewResult.verdict,
      ...(reviewResult.issues ? { issues: reviewResult.issues } : {}),
      ...(reviewResult.blockerReason ? { blockerReason: reviewResult.blockerReason } : {})
    },
    recovery,
    finalResultPath
  };
}

async function continueAfterReviewIssues(
  ctx: CliContext,
  sourceRun: Awaited<ReturnType<CliContext["store"]["listRuns"]>>[number],
  reviewIssues: string[],
  recovery: ReviewRetryOutcome["recovery"]
): Promise<ReviewRetryOutcome> {
  if (!sourceRun.branchName || !sourceRun.worktreePath) {
    throw new Error(`Run ${sourceRun.id} cannot continue review issues without a branch and worktree`);
  }
  const workItem = await mustGetWorkItem(ctx, sourceRun.workItemId);
  const requirement = await mustGetRequirement(ctx, workItem.requirementId);
  const verification = dedupeVerificationEntries([
    ...tagVerificationEntries(ctx.config.verification, "project"),
    ...tagVerificationEntries(workItem.briefVerification ?? [], "brief")
  ]);
  const existingRunIds = new Set((await ctx.store.listRuns()).map((run) => run.id));
  const result = await ctx.executionBackend.run({
    requirement,
    workItem,
    verification,
    followUp: {
      branchName: sourceRun.branchName,
      worktreePath: sourceRun.worktreePath,
      reviewComments: reviewIssues
    }
  });
  const continuationRun = (await ctx.store.listRuns()).find((candidate) =>
    candidate.workItemId === sourceRun.workItemId && !existingRunIds.has(candidate.id)
  );
  if (!continuationRun) {
    throw new Error(`Run ${sourceRun.id} did not create a continuation run for actionable review issues`);
  }
  const finalResultPath = path.join(continuationRun.runDir, "final-result.json");
  const finalResult = readJsonRecord(finalResultPath);
  if (!finalResult) {
    throw new Error(`Continuation run ${continuationRun.id} did not produce a final result`);
  }
  const evidencePacket = isRecord(finalResult.evidencePacket) ? finalResult.evidencePacket : {};
  fs.writeFileSync(finalResultPath, JSON.stringify({
    ...finalResult,
    recovery,
    evidencePacket: { ...evidencePacket, recovery }
  }, null, 2));
  await ctx.store.updateRun(continuationRun.id, {
    status: result.status === "failed" ? "failed" : "completed",
    summary: result.summary
  });
  await ctx.store.updateWorkItemStatus(sourceRun.workItemId, result.status);
  await refreshRequirementStatuses(ctx);
  const latestReview = getRecordArray(finalResult.reviewResults).at(-1);
  const verdict = latestReview?.verdict === "PASS" || latestReview?.verdict === "ISSUES" || latestReview?.verdict === "BLOCKED"
    ? latestReview.verdict
    : "BLOCKED";
  const issues = Array.isArray(latestReview?.issues)
    ? latestReview.issues.filter((issue): issue is string => typeof issue === "string")
    : undefined;
  return {
    runId: continuationRun.id,
    workItemId: sourceRun.workItemId,
    status: result.status,
    publishable: finalResult.publishable === true,
    reusedStages: recovery.reusedStages,
    retriedStages: recovery.retriedStages,
    review: {
      verdict,
      ...(issues?.length ? { issues } : {}),
      ...(typeof latestReview?.blockerReason === "string" ? { blockerReason: latestReview.blockerReason } : {})
    },
    recovery,
    finalResultPath
  };
}

async function persistReviewContractRetryFailure(input: {
  ctx: CliContext;
  run: Awaited<ReturnType<CliContext["store"]["listRuns"]>>[number];
  finalResult: Record<string, unknown>;
  finalResultPath: string;
  failure: Record<string, unknown>;
  recovery: ReviewRetryOutcome["recovery"];
  kind: "missing" | "empty" | "malformed";
  summary: string;
}): Promise<ReviewRetryOutcome> {
  const exhausted = input.recovery.reviewAttempt >= input.recovery.maxReviewAttempts;
  const reviewContractFailure = {
    ...input.failure,
    kind: input.kind,
    attempt: input.recovery.reviewAttempt
  };
  const whyNotPublishable = [input.summary];
  const evidence = isRecord(input.finalResult.evidencePacket) ? input.finalResult.evidencePacket : {};
  const { terminalFailure: _previousEvidenceFailure, ...evidenceWithoutFailure } = evidence;
  const terminalFailure = exhausted ? undefined : { category: "orchestrator" as const, message: input.summary };
  const updatedEvidence = {
    ...evidenceWithoutFailure,
    ...(terminalFailure ? { terminalFailure } : {}),
    publishability: {
      publishable: false,
      blockers: [{ category: "review", message: input.summary }]
    },
    recommendedHumanAction: exhausted ? "inspect" : "retry",
    recovery: input.recovery
  };
  emitRunEvent({
    event: "review_contract_failed",
    runId: input.run.id,
    workItemId: input.run.workItemId,
    stage: "review",
    attempt: input.recovery.reviewAttempt,
    reused: false,
    iteration: typeof input.failure.iteration === "number" ? input.failure.iteration : 1,
    phase: "review",
    failureKind: input.kind,
    message: input.summary,
    resultPath: typeof input.failure.resultPath === "string" ? input.failure.resultPath : input.finalResultPath
  });
  fs.writeFileSync(input.finalResultPath, JSON.stringify({
    ...input.finalResult,
    status: exhausted ? "blocked" : "failed",
    summary: input.summary,
    publishable: false,
    whyNotPublishable,
    publishabilityBlockers: updatedEvidence.publishability.blockers,
    reviewContractFailure,
    ...(terminalFailure ? { terminalFailure } : { terminalFailure: undefined }),
    recovery: input.recovery,
    evidencePacket: updatedEvidence
  }, null, 2));
  await input.ctx.store.updateRun(input.run.id, {
    status: exhausted ? "completed" : "failed",
    summary: input.summary,
    ...(terminalFailure ? { terminalFailure } : {})
  });
  await input.ctx.store.updateWorkItemStatus(input.run.workItemId, exhausted ? "blocked" : "failed");
  await refreshRequirementStatuses(input.ctx);
  return {
    runId: input.run.id,
    workItemId: input.run.workItemId,
    status: exhausted ? "blocked" : "failed",
    publishable: false,
    reusedStages: input.recovery.reusedStages,
    retriedStages: input.recovery.retriedStages,
    reviewContractFailure: {
      kind: input.kind,
      attempt: input.recovery.reviewAttempt,
      maxAttempts: input.recovery.maxReviewAttempts
    },
    recovery: input.recovery,
    finalResultPath: input.finalResultPath
  };
}

function failureLabel(result: VerificationCommandResult): string {
  return result.failureCategory === "environment"
    ? "Environment verification"
    : result.failureCategory === "verification"
      ? "Verification contract"
      : "Product verification";
}

function readJsonRecord(filename: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function getRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function summarizeReviewEvidence(reviewResults: Array<Record<string, unknown>>): {
  verdict: string;
  passCount: number;
  issueCount: number;
  addressedIssueCount: number;
  remainingIssues: string[];
} {
  const latest = reviewResults.at(-1);
  const remainingIssues = latest?.verdict === "ISSUES" && Array.isArray(latest.issues)
    ? latest.issues.filter((issue): issue is string => typeof issue === "string")
    : [];
  const issueCount = reviewResults.reduce((count, review) =>
    count + (Array.isArray(review.issues) ? review.issues.filter((issue) => typeof issue === "string").length : 0), 0);
  return {
    verdict: typeof latest?.verdict === "string" ? latest.verdict : "UNKNOWN",
    passCount: reviewResults.filter((review) => review.verdict === "PASS").length,
    issueCount,
    addressedIssueCount: Math.max(0, issueCount - remainingIssues.length),
    remainingIssues
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
