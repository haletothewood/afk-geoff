import type { ChangeRequest, ExternalRef, HydratedWorkItem, Requirement, RunRecord, RunnerKind, WorkItem } from "./domain.js";

export interface RequirementRepository {
  createRequirement(requirement: Requirement): Promise<void>;
  updateRequirementStatus(id: string, status: Requirement["status"]): Promise<void>;
  getRequirement(id: string): Promise<Requirement | undefined>;
  listRequirements(): Promise<Requirement[]>;
}

export interface WorkItemRepository {
  createDraftWorkItems(requirementId: string, summary: string, items: Array<Omit<WorkItem, "id" | "requirementId" | "status" | "executionSummary" | "createdAt" | "updatedAt"> & { executionSummary?: string; dependencyPlanKeys: string[] }>): Promise<HydratedWorkItem[]>;
  listWorkItems(): Promise<HydratedWorkItem[]>;
  listWorkItemsByRequirement(requirementId: string): Promise<HydratedWorkItem[]>;
  getWorkItem(id: string): Promise<HydratedWorkItem | undefined>;
  updateWorkItemStatus(id: string, status: WorkItem["status"]): Promise<void>;
  updateWorkItemSummary(id: string, summary: string): Promise<void>;
}

export interface RunRepository {
  createRun(run: RunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  listRuns(): Promise<RunRecord[]>;
}

export interface AgentRunner {
  kind: RunnerKind;
  requiredEnvVars(input?: { requiredEnv?: string[] }): string[];
  buildInvocation(input: {
    mode: "plan" | "work";
    promptPath: string;
    commandOverride?: string[];
  }): { command: string; args: string[] };
  buildReviewCommand(input: {
    briefPath: string;
    reviewCommandOverride?: string[];
    commandOverride?: string[];
  }): string[];
}

export interface CodeHost {
  assertRepository(cwd: string): Promise<string>;
  getRemoteSlug(cwd: string): Promise<{ owner: string; repo: string } | undefined>;
  createWorktree(input: { cwd: string; branchName: string; baseBranch: string; path: string }): Promise<void>;
  commitAll(input: { cwd: string; message: string }): Promise<{ created: boolean; sha?: string }>;
  pushBranch(input: { cwd: string; branchName: string }): Promise<void>;
  hasDiffAgainst(input: { cwd: string; baseBranch: string }): Promise<boolean>;
}

export interface WorkspaceRuntime {
  ensureImage(input: { cwd: string; image: string; dockerfilePath: string; buildContext: string }): Promise<void>;
  runWork(input: {
    image: string;
    worktreePath: string;
    runDir: string;
    envAllowlist: string[];
    command: string;
    args: string[];
    stdoutPath: string;
    stderrPath: string;
  }): Promise<number>;
}

export interface IssueMirror {
  mirrorRequirement(input: { owner: string; repo: string; requirement: Requirement }): Promise<ExternalRef>;
  mirrorWorkItem(input: { owner: string; repo: string; workItem: WorkItem; requirement: Requirement }): Promise<ExternalRef>;
  commentOnIssue(input: { owner: string; repo: string; issueNumber: number; body: string }): Promise<void>;
  syncIssues(input: { owner: string; repo: string; refs: ExternalRef[] }): Promise<Array<{ refId: string; open: boolean; comments: Array<{ id: string; body: string; createdAt: string }> }>>;
}

export interface ChangeRequestPublisher {
  openPullRequest(input: { owner: string; repo: string; changeRequest: ChangeRequest }): Promise<ExternalRef>;
  syncPullRequests(input: { owner: string; repo: string; refs: ExternalRef[] }): Promise<Array<{ refId: string; state: "open" | "closed"; merged: boolean }>>;
}
