import { getRequirementNextActions, getWorkItemNextActions, printNextActionLines, readRunProgress } from "../cli-utils.js";
import { mustGetRequirement } from "../store-helpers.js";
import type { CliContext } from "../types.js";

export async function showEntity(ctx: CliContext, entityId: string): Promise<void> {
  const requirement = await ctx.store.getRequirement(entityId);

  if (requirement) {
    const items = await ctx.store.listWorkItemsByRequirement(requirement.id);
    const issueRef = await ctx.store.getExternalRefForEntity("requirement", requirement.id, "issue");
    console.log(`Requirement ${requirement.id}`);
    console.log(`Title: ${requirement.title}`);
    console.log(`Status: ${requirement.status}`);
    console.log("");
    console.log(requirement.body);
    console.log("");
    console.log("Work items");
    for (const item of items) {
      console.log(`- ${item.id}  ${item.planKey}  ${item.status}  ${item.title}`);
    }
    if (issueRef?.url) {
      console.log("");
      console.log(`Mirrored issue: ${issueRef.url}`);
    }
    console.log("");
    printNextActionLines(getRequirementNextActions(items));
    return;
  }

  const workItem = await ctx.store.getWorkItem(entityId);

  if (!workItem) {
    throw new Error(`Entity ${entityId} not found`);
  }

  const requirementForItem = await mustGetRequirement(ctx, workItem.requirementId);
  const dependencyTitles = await Promise.all(
    workItem.dependencyIds.map(async (dependencyId) => (await ctx.store.getWorkItem(dependencyId))?.title ?? dependencyId)
  );
  const issueRef = await ctx.store.getExternalRefForEntity("work_item", workItem.id, "issue");
  const prRef = await ctx.store.getExternalRefForEntity("work_item", workItem.id, "pull_request");
  console.log(`Work item ${workItem.id}`);
  console.log(`Title: ${workItem.title}`);
  console.log(`Requirement: ${requirementForItem.id}  ${requirementForItem.title}`);
  console.log(`Type: ${workItem.type}`);
  console.log(`Status: ${workItem.status}`);
  console.log(`Plan key: ${workItem.planKey}`);
  console.log("");
  console.log(workItem.body);
  console.log("");
  console.log("Acceptance criteria");
  for (const criterion of workItem.acceptanceCriteria) {
    console.log(`- ${criterion}`);
  }
  console.log("");
  console.log("Dependencies");
  for (const title of dependencyTitles.length > 0 ? dependencyTitles : ["None"]) {
    console.log(`- ${title}`);
  }
  console.log("");
  console.log(`Execution summary: ${workItem.executionSummary}`);
  if (issueRef?.url) {
    console.log(`Mirrored issue: ${issueRef.url}`);
  }
  if (prRef?.url) {
    console.log(`Mirrored pull request: ${prRef.url}`);
  }

  const runs = await ctx.store.listRuns();
  const activeRun = runs
    .filter((run) => run.workItemId === workItem.id && (run.status === "running" || run.status === "prepared"))
    .at(0);
  if (activeRun) {
    const progress = readRunProgress(activeRun.runDir);
    if (progress) {
      console.log(`Active run: ${activeRun.id}`);
      console.log(`Progress: [${progress.phase}] ${progress.message} (iteration ${progress.iteration}, updated ${progress.updatedAt})`);
    }
  }

  console.log("");
  printNextActionLines(getWorkItemNextActions(workItem));
}
