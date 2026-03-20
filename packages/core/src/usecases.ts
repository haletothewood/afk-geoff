import type { DispatchDecision, HydratedWorkItem, Requirement, WorkItemStatus } from "./domain.js";

export function evaluateNextStatus(workItem: HydratedWorkItem, workItems: Map<string, HydratedWorkItem>): WorkItemStatus {
  if (workItem.status === "done" || workItem.status === "failed" || workItem.status === "in_progress") {
    return workItem.status;
  }

  if (workItem.status === "draft") {
    return "draft";
  }

  if (workItem.type === "hitl") {
    return "hitl_pending";
  }

  const blocked = workItem.dependencyIds.some((dependencyId) => {
    const dependency = workItems.get(dependencyId);
    return dependency?.status !== "done";
  });

  return blocked ? "blocked" : "todo";
}

export function classifyWorkItems(items: HydratedWorkItem[]): DispatchDecision {
  const runnable = items.filter((item) => item.type === "afk" && item.status === "todo");
  const blocked = items.filter((item) => item.type === "afk" && item.status === "blocked");
  const hitl = items.filter((item) => item.status === "hitl_pending");

  return { runnable, blocked, hitl };
}

export function createReviewBrief(requirement: Requirement, workItem: HydratedWorkItem, dependencyTitles: string[]): string {
  return [
    `Requirement: ${requirement.title}`,
    "",
    requirement.body,
    "",
    `Work item: ${workItem.title}`,
    "",
    workItem.body,
    "",
    "Acceptance criteria:",
    ...workItem.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Dependencies:",
    ...(dependencyTitles.length > 0 ? dependencyTitles.map((title) => `- ${title}`) : ["- None"])
  ].join("\n");
}

export function summarizeRequirementStatus(items: HydratedWorkItem[]): Requirement["status"] {
  if (items.length === 0) {
    return "captured";
  }

  if (items.every((item) => item.status === "done")) {
    return "completed";
  }

  if (items.every((item) => item.status === "draft")) {
    return "planned";
  }

  return "approved";
}
