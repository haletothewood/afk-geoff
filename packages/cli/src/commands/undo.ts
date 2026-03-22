import fs from "node:fs";
import { latestRunForWorkItem, mustGetWorkItem, refreshRequirementStatuses } from "../store-helpers.js";
import type { CliContext } from "../types.js";

export async function undoWorkItem(
  ctx: CliContext,
  workItemId: string,
  options: { deleteBranch: boolean }
): Promise<void> {
  if (!ctx.github || !ctx.remote) {
    throw new Error("Undo requires GitHub publishing to be enabled and authenticated");
  }

  const workItem = await mustGetWorkItem(ctx, workItemId);
  const prRef = await ctx.store.getExternalRefForEntity("work_item", workItem.id, "pull_request");

  if (!prRef) {
    throw new Error(`Work item ${workItem.id} does not have an AFK-created pull request to undo`);
  }

  const [pullState] = await ctx.github.syncPullRequests({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    refs: [prRef]
  });

  if (!pullState) {
    throw new Error(`Could not determine pull request state for ${workItem.id}`);
  }

  await ctx.store.saveSyncState({
    externalRefId: prRef.id,
    payload: pullState
  });

  if (pullState.merged) {
    throw new Error(`Pull request #${prRef.remoteNumber} is already merged; AFK undo only supports open, unmerged PRs`);
  }

  if (pullState.state === "closed") {
    throw new Error(`Pull request #${prRef.remoteNumber} is already closed`);
  }

  await ctx.github.closePullRequest({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    pullNumber: prRef.remoteNumber
  });
  await ctx.store.saveSyncState({
    externalRefId: prRef.id,
    payload: {
      refId: prRef.id,
      state: "closed",
      merged: false
    }
  });

  const latestRun = await latestRunForWorkItem(ctx, workItem.id);
  const branchName = latestRun?.branchName;
  const worktreePath = latestRun?.worktreePath;
  const summary = options.deleteBranch && branchName
    ? `Undone by operator: closed PR #${prRef.remoteNumber} and deleted branch ${branchName}`
    : `Undone by operator: closed PR #${prRef.remoteNumber}`;

  if (options.deleteBranch && worktreePath && fs.existsSync(worktreePath)) {
    await ctx.git.removeWorktree({
      cwd: ctx.repoRoot,
      path: worktreePath,
      force: true
    });
  }

  if (options.deleteBranch && branchName) {
    try {
      await ctx.git.deleteRemoteBranch({
        cwd: ctx.repoRoot,
        branchName
      });
    } catch {
      // Remote branch may already be gone; closing the PR is still the important part.
    }

    try {
      await ctx.git.deleteLocalBranch({
        cwd: ctx.repoRoot,
        branchName
      });
    } catch {
      // Local branch may already be gone or attached elsewhere; keep undo best-effort.
    }
  }

  await ctx.store.updateWorkItemStatus(workItem.id, "failed");
  await ctx.store.updateWorkItemSummary(workItem.id, summary);

  if (latestRun) {
    await ctx.store.updateRun(latestRun.id, {
      status: "failed",
      summary
    });
  }

  await refreshRequirementStatuses(ctx);

  console.log(`Closed PR #${prRef.remoteNumber} for ${workItem.id}`);
  if (options.deleteBranch && branchName) {
    console.log(`Deleted AFK branch ${branchName}`);
  }
}
