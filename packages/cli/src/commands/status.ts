import { classifyWorkItems } from "@afk-geoff/core";
import { getGlobalNextActions, printLinesOrNone, printNextActionLines, readRunProgress } from "../cli-utils.js";
import type { CliContext } from "../types.js";

export async function printStatus(ctx: CliContext): Promise<void> {
  const snapshot = await getStatusSnapshot(ctx);

  console.log("Requirements");
  printLinesOrNone(snapshot.requirements.map((requirement) => `- ${requirement.id}  ${requirement.title}  ${requirement.status}`));
  console.log("");
  console.log("Runnable AFK items");
  printLinesOrNone(snapshot.runnable.map((item) => `- ${item.id}  ${item.title}`));
  console.log("");
  console.log("Blocked items");
  printLinesOrNone(snapshot.blocked.map((item) => `- ${item.id}  ${item.title}`));
  console.log("");
  console.log("HITL items");
  printLinesOrNone(snapshot.hitl.map((item) => `- ${item.id}  ${item.title}`));
  console.log("");
  console.log("Active runs / open PRs");
  const activeLines = snapshot.active.map((entry) => entry.label);
  printLinesOrNone(activeLines);
  console.log("");
  printNextActionLines(snapshot.nextActions);
}

export async function getStatusSnapshot(ctx: CliContext) {
  const requirements = await ctx.store.listRequirements();
  const workItems = await ctx.store.listWorkItems();
  const runs = await ctx.store.listRuns();
  const prRefs = await ctx.store.listExternalRefs("work_item", "pull_request");
  const decisions = classifyWorkItems(workItems);
  const active: Array<Record<string, unknown> & { label: string }> = [];

  for (const run of runs.filter((record) => record.status === "running" || record.status === "prepared")) {
    const progress = readRunProgress(run.runDir);
    if (progress) {
      active.push({
        type: "run",
        id: run.id,
        workItemId: run.workItemId,
        status: run.status,
        progress,
        label: `- ${run.id}  ${run.workItemId}  ${run.status}  [${progress.phase}] ${progress.message} (iteration ${progress.iteration}, updated ${progress.updatedAt})`
      });
    } else {
      active.push({
        type: "run",
        id: run.id,
        workItemId: run.workItemId,
        status: run.status,
        label: `- ${run.id}  ${run.workItemId}  ${run.status}`
      });
    }
  }
  for (const ref of prRefs) {
    const syncState = await ctx.store.getSyncState(ref.id) as { state?: "open" | "closed"; merged?: boolean } | undefined;
    if (syncState?.state === "closed" || syncState?.merged) {
      continue;
    }
    const workItem = workItems.find((item) => item.id === ref.entityId);
    if (workItem?.status !== "done") {
      active.push({
        type: "pull_request",
        id: ref.id,
        workItemId: ref.entityId,
        remoteNumber: ref.remoteNumber,
        url: ref.url,
        title: workItem?.title,
        label: `- PR #${ref.remoteNumber}  ${workItem?.title ?? ref.entityId}`
      });
    }
  }

  return {
    requirements,
    workItems,
    runnable: decisions.runnable,
    blocked: decisions.blocked,
    hitl: decisions.hitl,
    active,
    nextActions: getGlobalNextActions(requirements, workItems)
  };
}
