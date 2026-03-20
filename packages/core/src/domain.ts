export type RunnerKind = "claude" | "codex";
export type WorkItemType = "afk" | "hitl";
export type WorkItemStatus = "draft" | "todo" | "blocked" | "in_progress" | "hitl_pending" | "done" | "failed";
export type RequirementStatus = "captured" | "planned" | "approved" | "completed";
export type RunStatus = "prepared" | "running" | "completed" | "failed";
export type ExternalRefType = "issue" | "pull_request";

export interface Requirement {
  id: string;
  title: string;
  body: string;
  status: RequirementStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  requirementId: string;
  title: string;
  body: string;
  type: WorkItemType;
  status: WorkItemStatus;
  planKey: string;
  executionSummary: string;
  acceptanceCriteria: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HydratedWorkItem extends WorkItem {
  dependencyIds: string[];
}

export interface RunRecord {
  id: string;
  workItemId: string;
  mode: "plan" | "work" | "review";
  status: RunStatus;
  branchName?: string;
  worktreePath?: string;
  runDir: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalRef {
  id: string;
  entityType: "requirement" | "work_item";
  entityId: string;
  provider: "github";
  remoteType: ExternalRefType;
  remoteNumber: number;
  remoteId?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeRequest {
  workItemId: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface DispatchDecision {
  runnable: HydratedWorkItem[];
  blocked: HydratedWorkItem[];
  hitl: HydratedWorkItem[];
}
