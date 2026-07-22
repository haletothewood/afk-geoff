import fs from "node:fs";
import type { PullRequestReviewSource } from "@afk-geoff/core";
import { buildFallbackSourceComment } from "../cli-utils.js";
import { latestRunForWorkItem, mustGetRequirement, mustGetWorkItem, refreshRequirementStatuses } from "../store-helpers.js";
import type { CliContext, RunOutcome } from "../types.js";

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
  const reviewComments = comments.map(formatReviewComment);

  if (reviewComments.length === 0) {
    throw new Error(`Pull request ${pullRef.remoteNumber} has no actionable review comments.`);
  }

  const latestRun = await latestRunForWorkItem(ctx, workItem.id);
  const branchName = latestRun?.branchName;

  if (!branchName) {
    throw new Error(`Work item ${workItem.id} does not have a recorded AFK branch.`);
  }

  const requirement = await mustGetRequirement(ctx, workItem.requirementId);
  const result = await ctx.executionBackend.run({
    requirement,
    workItem,
    verification: ctx.config.verification,
    followUp: {
      branchName,
      ...(latestRun.worktreePath && fs.existsSync(latestRun.worktreePath) ? { worktreePath: latestRun.worktreePath } : {}),
      reviewComments
    }
  });

  if (result.status === "blocked" || result.status === "failed") {
    return {};
  }

  if (result.hasDiff && result.branchName && result.worktreePath) {
    await ctx.git.pushBranch({
      cwd: result.worktreePath,
      branchName: result.branchName
    });
  }

  const followUpRun = await latestRunForWorkItem(ctx, workItem.id);
  await ctx.store.updateWorkItemStatus(workItem.id, "done");
  if (followUpRun) {
    await ctx.store.updateRun(followUpRun.id, { status: "completed", summary: result.summary });
  }
  await refreshRequirementStatuses(ctx);

  const prUrl = pullRef.url;
  const issueComment = result.issueComment.trim() || buildFallbackSourceComment({ status: "done", summary: result.summary, ...(prUrl ? { prUrl } : {}) });
  console.log(`Addressed ${reviewComments.length} review comment(s) on PR #${pullRef.remoteNumber}`);
  if (result.hasDiff) {
    console.log(`Pushed follow-up to ${prUrl ?? `PR #${pullRef.remoteNumber}`}`);
  } else {
    console.log("No repository changes were needed");
  }
  console.log(issueComment);

  return {
    ...(prUrl ? { prUrl } : {})
  };
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

function formatReviewComment(comment: { id: string; body: string; path?: string; line?: number }): string {
  const location = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""}` : "PR review";
  return `[${comment.id}] ${location}: ${comment.body}`;
}
