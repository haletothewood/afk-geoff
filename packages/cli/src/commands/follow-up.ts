import fs from "node:fs";
import path from "node:path";
import type { CommitSignatureVerificationSource, PullRequestReviewSource } from "@afk-geoff/core";
import { dedupeVerificationEntries, resolvePackageManagerContract, tagVerificationEntries, verificationCommands } from "@afk-geoff/shared";
import { attachTerminalFailure, buildFallbackSourceComment, formatErrorMessage, terminalFailureFromError } from "../cli-utils.js";
import { latestRunForWorkItem, markWorkItemRunFailed, mustGetRequirement, mustGetWorkItem, refreshRequirementStatuses } from "../store-helpers.js";
import type { CliContext, ReviewCommentSummary, RunOutcome, VerificationSummary } from "../types.js";

export async function runPullRequestFollowUp(ctx: CliContext, workItemId: string): Promise<RunOutcome> {
  const workItem = await mustGetWorkItem(ctx, workItemId);

  if (workItem.type !== "afk") {
    throw new Error(`Work item ${workItemId} is not AFK.`);
  }

  if (!ctx.github || !ctx.remote) {
    throw new Error("PR follow-up requires GitHub publishing to be configured.");
  }

  const reviewSource = asPullRequestReviewSource(ctx.github);
  if (!reviewSource) {
    throw new Error("PR follow-up requires a GitHub adapter that can read pull request review comments.");
  }

  const pullRef = await ctx.store.getExternalRefForEntity("work_item", workItem.id, "pull_request");
  if (!pullRef) {
    throw new Error(`Work item ${workItem.id} does not have an AFK-created pull request.`);
  }

  const syncState = await ctx.store.getSyncState(pullRef.id) as { state?: string; merged?: boolean } | undefined;
  if (syncState?.merged || syncState?.state === "closed") {
    throw new Error(`Pull request ${pullRef.remoteNumber} is not open.`);
  }

  const comments = await reviewSource.listPullRequestReviewComments({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    pullNumber: pullRef.remoteNumber
  });
  const actionableReviewComments = comments.map(normalizeReviewComment);
  const reviewComments = actionableReviewComments.map(formatReviewComment);

  if (reviewComments.length === 0) {
    throw new Error(`Pull request ${pullRef.remoteNumber} has no actionable review comments.`);
  }

  const latestRun = await latestRunForWorkItem(ctx, workItem.id);
  const branchName = latestRun?.branchName;

  if (!branchName) {
    throw new Error(`Work item ${workItem.id} does not have a recorded AFK branch.`);
  }

  const requirement = await mustGetRequirement(ctx, workItem.requirementId);
  const verificationContract = dedupeVerificationEntries([
    ...tagVerificationEntries(ctx.config.verification, "project"),
    ...tagVerificationEntries(workItem.briefVerification ?? [], "brief")
  ]);
  const followUpWorktreePath = latestRun.worktreePath && fs.existsSync(latestRun.worktreePath)
    ? latestRun.worktreePath
    : undefined;
  if (followUpWorktreePath) {
    resolvePackageManagerContract(followUpWorktreePath, verificationCommands(verificationContract));
  }
  const previousRun = await latestRunForWorkItem(ctx, workItem.id);
  let result: Awaited<ReturnType<CliContext["executionBackend"]["run"]>>;
  try {
    result = await ctx.executionBackend.run({
      requirement,
      workItem,
      verification: verificationContract,
      followUp: {
        branchName,
        ...(followUpWorktreePath ? { worktreePath: followUpWorktreePath } : {}),
        reviewComments
      }
    });
  } catch (error) {
    const terminalFailure = {
      category: "orchestrator" as const,
      message: `Follow-up orchestration failed: ${formatErrorMessage(error)}`
    };
    const latestRun = await latestRunForWorkItem(ctx, workItem.id);
    if (latestRun && latestRun.id !== previousRun?.id) {
      try {
        await markWorkItemRunFailed(
          ctx,
          workItem.id,
          terminalFailure.message,
          terminalFailure.category,
          { persistFinalResult: false }
        );
      } catch {
        // Preserve the original orchestration failure when terminal state persistence is also unavailable.
      }
    }
    throw attachTerminalFailure(error, terminalFailure);
  }

  if (result.status === "blocked" || result.status === "failed") {
    let run = await latestRunForWorkItem(ctx, workItem.id);
    const finalResultPath = run ? path.join(run.runDir, "final-result.json") : undefined;
    if (
      result.status === "failed"
      && run
      && (!run.terminalFailure || !finalResultPath || !fs.existsSync(finalResultPath))
    ) {
      await markWorkItemRunFailed(ctx, workItem.id, result.summary);
      run = await latestRunForWorkItem(ctx, workItem.id);
    }
    const verification = readVerificationSummary(run?.runDir);
    return {
      workItemId: workItem.id,
      ...(run
        ? {
            runId: run.id,
            status: result.status,
            ...(run.branchName ? { branchName: run.branchName } : {}),
            ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
            runDir: run.runDir,
            ...(fs.existsSync(path.join(run.runDir, "result.json"))
              ? { resultPath: path.join(run.runDir, "result.json") }
              : {}),
            ...(fs.existsSync(path.join(run.runDir, "final-result.json"))
              ? { finalResultPath: path.join(run.runDir, "final-result.json") }
              : {}),
            ...(run.terminalFailure ? { terminalFailure: run.terminalFailure } : {}),
            actionableReviewComments,
            ...(verification ? { verification } : {}),
            ...(pullRef.url ? { prUrl: pullRef.url } : {})
          }
        : { status: result.status, actionableReviewComments, ...(pullRef.url ? { prUrl: pullRef.url } : {}) })
    };
  }

  if (result.hasDiff && result.branchName && result.worktreePath) {
    try {
      await ctx.git.pushBranch({
        cwd: result.worktreePath,
        branchName: result.branchName
      });
    } catch (error) {
      const terminalFailure = {
        category: "publishing" as const,
        message: `Follow-up publication failed: ${formatErrorMessage(error)}`
      };
      await markWorkItemRunFailed(ctx, workItem.id, terminalFailure.message, terminalFailure.category);
      throw attachTerminalFailure(error, terminalFailure);
    }
    if (ctx.commitSigningPolicy.enforced) {
      try {
        await assertGitHubVerifiedSignatures(ctx, result.worktreePath);
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        const blockedRun = await latestRunForWorkItem(ctx, workItem.id);
        if (blockedRun) {
          markHostSignatureVerificationFailure(blockedRun.runDir, summary);
          await ctx.store.updateRun(blockedRun.id, { status: "completed", summary });
        }
        await ctx.store.updateWorkItemStatus(workItem.id, "blocked");
        return {
          workItemId: workItem.id,
          ...(blockedRun ? { runId: blockedRun.id, status: "blocked" as const } : { status: "blocked" as const }),
          branchName: result.branchName,
          actionableReviewComments,
          ...(pullRef.url ? { prUrl: pullRef.url } : {})
        };
      }
    }
  }

  const followUpRun = await latestRunForWorkItem(ctx, workItem.id);
  await ctx.store.updateWorkItemStatus(workItem.id, "done");
  if (followUpRun) {
    await ctx.store.updateRun(followUpRun.id, { status: "completed", summary: result.summary });
  }
  await refreshRequirementStatuses(ctx);
  const verification = readVerificationSummary(followUpRun?.runDir);

  const prUrl = pullRef.url;
  const issueComment = result.issueComment.trim() || buildFallbackSourceComment({ status: "done", summary: result.summary, ...(prUrl ? { prUrl } : {}) });
  console.log(`Addressed ${reviewComments.length} review comment(s) on PR #${pullRef.remoteNumber}`);
  for (const comment of actionableReviewComments) {
    console.log(`- ${comment.id} ${comment.location}`);
  }
  if (result.hasDiff) {
    console.log(`Pushed follow-up to ${prUrl ?? `PR #${pullRef.remoteNumber}`}`);
  } else {
    console.log("No repository changes were needed");
  }
  console.log(issueComment);

  return {
    workItemId: workItem.id,
    ...(followUpRun
      ? {
          runId: followUpRun.id,
          status: "completed",
          ...(followUpRun.branchName ? { branchName: followUpRun.branchName } : {}),
          ...(followUpRun.worktreePath ? { worktreePath: followUpRun.worktreePath } : {})
        }
      : { status: "completed" }),
    branchName: result.branchName ?? branchName,
    actionableReviewComments,
    addressedReviewComments: reviewComments.length,
    ...(verification ? { verification } : {}),
    ...(prUrl ? { prUrl } : {})
  };
}

async function assertGitHubVerifiedSignatures(ctx: CliContext, worktreePath: string): Promise<void> {
  if (!ctx.git.listCommitsSince || !ctx.github || !("verifyCommitSignatures" in ctx.github)) {
    throw new Error("GitHub verified-signature confirmation is unavailable after follow-up push");
  }
  const verifier = ctx.github as typeof ctx.github & CommitSignatureVerificationSource;
  const shas = await ctx.git.listCommitsSince({ cwd: worktreePath, baseBranch: ctx.config.baseBranch });
  const verification = await verifier.verifyCommitSignatures({ owner: ctx.remote!.owner, repo: ctx.remote!.repo, shas });
  const rejected = verification.filter((commit) => !commit.verified);
  if (rejected.length > 0) {
    throw new Error(`GitHub rejected commit signature verification for ${rejected.map((commit) => `${commit.sha}${commit.reason ? ` (${commit.reason})` : ""}`).join(", ")}`);
  }
}

function markHostSignatureVerificationFailure(runDir: string, message: string): void {
  const finalResultPath = path.join(runDir, "final-result.json");
  const finalResult = readJsonObject(finalResultPath);
  if (!finalResult) return;
  const whyNotPublishable = [...new Set([...(Array.isArray(finalResult.whyNotPublishable) ? finalResult.whyNotPublishable.filter((value): value is string => typeof value === "string") : []), message])];
  const evidencePacket = isObject(finalResult.evidencePacket) ? finalResult.evidencePacket : {};
  const commitSigning = isObject(evidencePacket.commitSigning) ? evidencePacket.commitSigning : {};
  const blocker = { category: "policy", message };
  fs.writeFileSync(finalResultPath, JSON.stringify({
    ...finalResult,
    status: "blocked",
    publishable: false,
    whyNotPublishable,
    publishabilityBlockers: [blocker],
    evidencePacket: {
      ...evidencePacket,
      commitSigning: { ...commitSigning, satisfied: false, hostVerification: { verified: false, message } },
      publishability: { publishable: false, blockers: [blocker] },
      recommendedHumanAction: "fix_environment"
    }
  }, null, 2));
}

function asPullRequestReviewSource(value: unknown): PullRequestReviewSource | undefined {
  if (
    value &&
    typeof value === "object" &&
    "listPullRequestReviewComments" in value &&
    typeof (value as { listPullRequestReviewComments?: unknown }).listPullRequestReviewComments === "function"
  ) {
    return value as PullRequestReviewSource;
  }

  return undefined;
}

function normalizeReviewComment(comment: { id: string; body: string; path?: string; line?: number }): ReviewCommentSummary {
  const location = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""}` : "PR review";
  return {
    id: comment.id,
    location,
    body: comment.body,
    ...(comment.path ? { path: comment.path } : {}),
    ...(typeof comment.line === "number" ? { line: comment.line } : {})
  };
}

function formatReviewComment(comment: ReviewCommentSummary): string {
  return `[${comment.id}] ${comment.location}: ${comment.body}`;
}

function readVerificationSummary(runDir: string | undefined): VerificationSummary | undefined {
  if (!runDir) {
    return undefined;
  }

  const finalResultPath = path.join(runDir, "final-result.json");
  if (!fs.existsSync(finalResultPath)) {
    return undefined;
  }

  const finalResult = readJsonObject(finalResultPath);
  const evidencePacket = isObject(finalResult?.evidencePacket) ? finalResult.evidencePacket : undefined;
  const evidenceVerification = isObject(evidencePacket?.verification) ? evidencePacket.verification : undefined;
  const evidenceStatus = typeof evidenceVerification?.status === "string" ? evidenceVerification.status : undefined;
  const evidenceCommands = getVerificationCommands(evidenceVerification?.commands);

  if (isVerificationStatus(evidenceStatus)) {
    return {
      status: evidenceStatus,
      commands: evidenceCommands
    };
  }

  const verificationSummaries = getArray<Record<string, unknown>>(finalResult?.verificationSummaries);
  const commands = verificationSummaries.flatMap((summary) => getVerificationCommands(summary.results));
  if (commands.length === 0) {
    return { status: "skipped", commands: [] };
  }

  return {
    status: commands.every((command) => command.passed) ? "passed" : "failed",
    commands
  };
}

function readJsonObject(filename: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getVerificationCommands(value: unknown): VerificationSummary["commands"] {
  return getArray<Record<string, unknown>>(value).flatMap((command) => {
    if (
      typeof command.command !== "string" ||
      typeof command.passed !== "boolean" ||
      typeof command.exitCode !== "number"
    ) {
      return [];
    }

    const origins = getVerificationOrigins(command.origins);
    return [{
      command: command.command,
      passed: command.passed,
      exitCode: command.exitCode,
      ...(origins.length > 0 ? { origins } : {})
    }];
  });
}

function getVerificationOrigins(value: unknown): Array<"project" | "brief"> {
  return getArray<unknown>(value).filter(
    (origin): origin is "project" | "brief" =>
      origin === "project" || origin === "brief"
  );
}

function getArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerificationStatus(value: string | undefined): value is VerificationSummary["status"] {
  return value === "passed" || value === "failed" || value === "skipped" || value === "unknown";
}
