import { summarizeRequirementStatus } from "@afk-geoff/core";
import type { HydratedWorkItem, Requirement } from "@afk-geoff/core";
import { delay, processExists, readWorkerProcessInfo } from "./cli-utils.js";
import type { CliContext } from "./types.js";

export async function mustGetRequirement(ctx: CliContext, requirementId: string): Promise<Requirement> {
  const requirement = await ctx.store.getRequirement(requirementId);

  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`);
  }

  return requirement;
}

export async function mustGetWorkItem(ctx: CliContext, workItemId: string): Promise<HydratedWorkItem> {
  const item = await ctx.store.getWorkItem(workItemId);

  if (!item) {
    throw new Error(`Work item ${workItemId} not found`);
  }

  return item;
}

export async function latestRunForWorkItem(ctx: CliContext, workItemId: string) {
  const runs = await ctx.store.listRuns();
  return runs
    .filter((run) => run.workItemId === workItemId && run.mode === "work")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export async function refreshRequirementStatuses(ctx: CliContext): Promise<void> {
  const requirements = await ctx.store.listRequirements();

  for (const requirement of requirements) {
    const items = await ctx.store.listWorkItemsByRequirement(requirement.id);
    const nextStatus = summarizeRequirementStatus(items);

    if (nextStatus !== requirement.status) {
      await ctx.store.updateRequirementStatus(requirement.id, nextStatus);
    }
  }
}

export async function markWorkItemRunFailed(ctx: CliContext, workItemId: string, summary: string): Promise<void> {
  await ctx.store.updateWorkItemStatus(workItemId, "failed");
  const latestRun = await latestRunForWorkItem(ctx, workItemId);
  if (latestRun) {
    await ctx.store.updateRun(latestRun.id, { status: "failed", summary });
  }
  await refreshRequirementStatuses(ctx);
}

export async function terminateRunWorker(runDir: string): Promise<void> {
  const processInfo = readWorkerProcessInfo(runDir);
  if (!processInfo) {
    return;
  }

  const { pid } = processInfo;
  if (!processExists(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await delay(200);
  if (processExists(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // best-effort cleanup
    }
  }
}
