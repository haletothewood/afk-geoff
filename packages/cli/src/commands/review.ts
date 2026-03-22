import fs from "node:fs";
import path from "node:path";
import { createReviewBrief } from "@afk-geoff/core";
import { branchNameForWorkItem } from "@afk-geoff/adapter-local-git";
import { buildReviewBrief as buildRichReviewBrief, createId, maybeReadOverride } from "@afk-geoff/shared";
import { withCommandOverride, withReviewCommand, withText } from "../cli-utils.js";
import { mustGetRequirement, mustGetWorkItem } from "../store-helpers.js";
import type { CliContext } from "../types.js";

export async function prepareReview(ctx: CliContext, workItemId: string): Promise<void> {
  const workItem = await mustGetWorkItem(ctx, workItemId);

  if (workItem.status !== "hitl_pending") {
    throw new Error(`Work item ${workItemId} is not HITL pending.`);
  }

  const requirement = await mustGetRequirement(ctx, workItem.requirementId);
  const runId = createId("run");
  const branchName = branchNameForWorkItem(`review-${workItem.title}`);
  const worktreePath = path.join(ctx.paths.worktreesDir, runId);
  const runDir = path.join(ctx.paths.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  await ctx.git.createWorktree({
    cwd: ctx.repoRoot,
    branchName,
    baseBranch: ctx.config.baseBranch,
    path: worktreePath
  });

  const allItems = await ctx.store.listWorkItemsByRequirement(requirement.id);
  const dependencyTitles = workItem.dependencyIds
    .map((dependencyId) => allItems.find((item) => item.id === dependencyId)?.title)
    .filter((title): title is string => Boolean(title));
  const reviewPath = path.join(runDir, "review.md");
  const reviewBrief = buildRichReviewBrief({
    requirement,
    workItem,
    dependencyTitles,
    ...withText("overrideText", maybeReadOverride(ctx.repoRoot, ctx.config.prompts?.review))
  });
  fs.writeFileSync(reviewPath, reviewBrief);

  await ctx.store.createRun({
    id: runId,
    workItemId: workItem.id,
    mode: "review",
    status: "prepared",
    branchName,
    worktreePath,
    runDir,
    summary: createReviewBrief(requirement, workItem, dependencyTitles),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const relativeBriefPath = path.relative(worktreePath, reviewPath) || reviewPath;
  const command = ctx.runner.buildReviewCommand({
    briefPath: relativeBriefPath,
    ...withReviewCommand(ctx.config.runner.reviewCommand),
    ...withCommandOverride(ctx.config.runner.command)
  });
  console.log(`cd ${worktreePath}`);
  console.log(command.join(" "));
}
