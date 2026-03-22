import { classifyWorkItems } from "@afk-geoff/core";
import { getGlobalNextActions, printLinesOrNone, printNextActionLines, readRunProgress } from "../cli-utils.js";
import type { CliContext } from "../types.js";

export async function printStatus(ctx: CliContext): Promise<void> {
  const requirements = await ctx.store.listRequirements();
  const workItems = await ctx.store.listWorkItems();
  const runs = await ctx.store.listRuns();
  const prRefs = await ctx.store.listExternalRefs("work_item", "pull_request");
  const decisions = classifyWorkItems(workItems);

  console.log("Requirements");
  printLinesOrNone(requirements.map((requirement) => `- ${requirement.id}  ${requirement.title}  ${requirement.status}`));
  console.log("");
  console.log("Runnable AFK items");
  printLinesOrNone(decisions.runnable.map((item) => `- ${item.id}  ${item.title}`));
  console.log("");
  console.log("Blocked items");
  printLinesOrNone(decisions.blocked.map((item) => `- ${item.id}  ${item.title}`));
  console.log("");
  console.log("HITL items");
  printLinesOrNone(decisions.hitl.map((item) => `- ${item.id}  ${item.title}`));
  console.log("");
  console.log("Active runs / open PRs");
  const activeLines: string[] = [];
  for (const run of runs.filter((record) => record.status === "running" || record.status === "prepared")) {
    const progress = readRunProgress(run.runDir);
    if (progress) {
      activeLines.push(`- ${run.id}  ${run.workItemId}  ${run.status}  [${progress.phase}] ${progress.message} (iteration ${progress.iteration}, updated ${progress.updatedAt})`);
    } else {
      activeLines.push(`- ${run.id}  ${run.workItemId}  ${run.status}`);
    }
  }
  for (const ref of prRefs) {
    const syncState = await ctx.store.getSyncState(ref.id) as { state?: "open" | "closed"; merged?: boolean } | undefined;
    if (syncState?.state === "closed" || syncState?.merged) {
      continue;
    }
    const workItem = workItems.find((item) => item.id === ref.entityId);
    if (workItem?.status !== "done") {
      activeLines.push(`- PR #${ref.remoteNumber}  ${workItem?.title ?? ref.entityId}`);
    }
  }
  printLinesOrNone(activeLines);
  console.log("");
  printNextActionLines(getGlobalNextActions(requirements, workItems));
}
