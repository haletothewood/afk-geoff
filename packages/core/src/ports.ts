import type { ChangeRequest, ExternalRef, HydratedWorkItem, Requirement, RunRecord, RunnerKind, WorkItem, WorkItemStatus } from "./domain.js";

export interface ExecutionBrief {
  requirementBody: string;
  workItemTitle: string;
  workItemBody: string;
  acceptanceCriteria: string[];
  verification: string[];
  issueUrl?: string;
  /** Explicit primary execution mode, "auto" to infer, or undefined (treated as "auto"). */
  executionMode?: string;
  /** Explicit overlay list, ["auto"] to infer, or undefined (treated as auto-inferred). */
  overlays?: string[];
  /** Explicit risk tolerance, "auto" to infer, or undefined (treated as "auto"). */
  risk?: string;
}

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
    model?: string;
  }): { command: string; args: string[]; promptTransport: "arg" | "stdin" };
  buildReviewCommand(input: {
    briefPath: string;
    reviewCommandOverride?: string[];
    commandOverride?: string[];
  }): string[];
  buildReviewInvocation(input: {
    reviewPromptPath: string;
    reviewCommandOverride?: string[];
    commandOverride?: string[];
    model?: string;
  }): { command: string; args: string[]; promptTransport: "arg" | "stdin" };
}

export interface WorkSource<TInput = string> {
  load(input: TInput): Promise<ExecutionBrief>;
}

export interface ExecutionBackendInput {
  requirement: Requirement;
  workItem: HydratedWorkItem;
  verification: string[];
  issueUrl?: string;
  followUp?: {
    branchName: string;
    worktreePath?: string;
    reviewComments: string[];
  };
  /** Optional execution mode configuration propagated from the execution brief. */
  executionModeConfig?: {
    executionMode?: string;
    overlays?: string[];
    risk?: string;
  };
}

export interface ExecutionBackendResult {
  status: Extract<WorkItemStatus, "done" | "blocked" | "failed">;
  summary: string;
  issueComment: string;
  hasDiff: boolean;
  branchName?: string;
  worktreePath?: string;
  pullRequest?: {
    title: string;
    body: string;
    manualQa?: string[];
  };
}

export interface ExecutionBackend {
  run(input: ExecutionBackendInput): Promise<ExecutionBackendResult>;
}

export interface CodeHost {
  assertRepository(cwd: string): Promise<string>;
  getRemoteSlug(cwd: string): Promise<{ owner: string; repo: string } | undefined>;
  createWorktree(input: { cwd: string; branchName: string; baseBranch: string; path: string }): Promise<void>;
  createWorktreeFromBranch(input: { cwd: string; branchName: string; path: string }): Promise<void>;
  removeWorktree(input: { cwd: string; path: string; force?: boolean }): Promise<void>;
  commitAll(input: { cwd: string; message: string }): Promise<{ created: boolean; sha?: string }>;
  pushBranch(input: { cwd: string; branchName: string }): Promise<void>;
  deleteRemoteBranch(input: { cwd: string; branchName: string }): Promise<void>;
  deleteLocalBranch(input: { cwd: string; branchName: string }): Promise<void>;
  hasDiffAgainst(input: { cwd: string; baseBranch: string }): Promise<boolean>;
}

export interface WorkspaceRuntime {
  ensureImage(input: { cwd: string; image: string; dockerfilePath: string; buildContext: string }): Promise<void>;
  runWork(input: {
    image: string;
    repoGitDir: string;
    worktreePath: string;
    runDir: string;
    envAllowlist: string[];
    extraEnv?: NodeJS.ProcessEnv;
    command: string;
    args: string[];
    stdin?: string;
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
  closePullRequest(input: { owner: string; repo: string; pullNumber: number }): Promise<void>;
  syncPullRequests(input: { owner: string; repo: string; refs: ExternalRef[] }): Promise<Array<{ refId: string; state: "open" | "closed"; merged: boolean }>>;
}

export interface PullRequestReviewSource {
  listPullRequestReviewComments(input: { owner: string; repo: string; pullNumber: number }): Promise<Array<{ id: string; body: string; path?: string; line?: number }>>;
}

export interface WorkflowDispatcher {
  dispatchWorkflow(input: {
    owner: string;
    repo: string;
    workflowId: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void>;
}

export interface WorkflowRunSource {
  listWorkflowRuns(input: {
    owner: string;
    repo: string;
    workflowId: string;
    limit: number;
  }): Promise<Array<{
    id: string;
    name?: string;
    status?: string;
    conclusion?: string;
    branch?: string;
    event?: string;
    url?: string;
    createdAt?: string;
    updatedAt?: string;
  }>>;
}

export interface SourceUpdatePayload {
  status: "done" | "blocked" | "failed";
  summary: string;
  issueComment: string;
  prUrl?: string;
}

export interface SourceUpdater {
  update(payload: SourceUpdatePayload): Promise<void>;
}

export interface PublicationResult {
  externalRef?: ExternalRef;
  url?: string;
}

export interface ResultPublisher {
  publish(input: {
    workItem: HydratedWorkItem;
    branchName: string;
    worktreePath: string;
    baseBranch: string;
    summary: string;
    agentName: string;
    modelLabel: string;
    pullRequest?: {
      title: string;
      body: string;
      manualQa?: string[];
    };
  }): Promise<PublicationResult>;
}
