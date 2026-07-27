import type { AgentRunner, ExecutionBackend, IssueMirror, PullRequestReviewSource, ResultPublisher, SourceUpdater, WorkspaceRuntime, WorkflowArtifactSource, WorkflowDispatcher, WorkflowRunSource } from "@afk-geoff/core";
import type { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import type { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";
import type { ChangeRequestPublisher } from "@afk-geoff/core";

export type ExecutionBackendKind = ReturnType<typeof loadProjectConfig>["execution"]["backend"];

export interface CliContext {
  cwd: string;
  repoRoot: string;
  config: ReturnType<typeof loadProjectConfig>;
  paths: ReturnType<typeof resolveProjectPaths>;
  store: SqliteStateStore;
  git: LocalGitCodeHost;
  runtime: WorkspaceRuntime;
  runner: AgentRunner;
  executionBackendKind: ExecutionBackendKind;
  githubToken: string | undefined;
  github: (IssueMirror & ChangeRequestPublisher & Partial<PullRequestReviewSource> & Partial<WorkflowArtifactSource> & Partial<WorkflowDispatcher> & Partial<WorkflowRunSource>) | undefined;
  executionBackend: ExecutionBackend;
  resultPublisher: ResultPublisher | undefined;
  remote: { owner: string; repo: string } | undefined;
  sourceUpdaterFactory: (issueUrl: string) => SourceUpdater;
}

export interface CliDependencies {
  githubFactory?: (token: string) => IssueMirror & ChangeRequestPublisher & Partial<PullRequestReviewSource> & Partial<WorkflowArtifactSource> & Partial<WorkflowDispatcher> & Partial<WorkflowRunSource>;
  githubIssueWorkSourceFactory?: (token: string) => import("@afk-geoff/core").WorkSource<string>;
  githubTokenResolver?: () => Promise<string | undefined>;
  /** Override the mechanism used to spawn the background worker for --detach runs. */
  detachLauncher?: (argv: string[], env: NodeJS.ProcessEnv, cwd: string) => { pid: number };
  /** Override the poll interval for afk watch (milliseconds). Defaults to 2000. */
  watchPollIntervalMs?: number;
  /** Hook called after each watch poll iteration; useful for tests to mutate state. */
  onAfterPoll?: () => Promise<void>;
  /**
   * Override the git remote reachability check performed during preflight for --pr runs.
   * Defaults to `git ls-remote --heads origin`. Should throw with a "Preflight failed (git):" message on failure.
   */
  gitRemoteChecker?: (repoRoot: string) => Promise<void>;
  /**
   * Override the GitHub token auth verification performed during preflight for --pr runs.
   * Defaults to a GET /user API call. Should throw with a "Preflight failed (github):" message on failure.
   */
  githubAuthVerifier?: (token: string, remote: { owner: string; repo: string }) => Promise<void>;
  /** Override the configured execution backend for one command invocation. */
  backendOverride?: ExecutionBackendKind;
}

export interface RunOutcome {
  workItemId?: string;
  requirementId?: string;
  runId?: string;
  status?: "completed" | "failed" | "blocked" | "running" | "prepared";
  branchName?: string;
  worktreePath?: string;
  runDir?: string;
  detachLogPaths?: {
    stdout: string;
    stderr: string;
  };
  resultPath?: string;
  finalResultPath?: string;
  finalVerdict?: string;
  prUrl?: string;
  actionableReviewComments?: ReviewCommentSummary[];
  addressedReviewComments?: number;
  backend?: ExecutionBackendKind;
}

export interface ReviewCommentSummary {
  id: string;
  location: string;
  body: string;
  path?: string;
  line?: number;
}

export interface DetachedRunOptions {
  verification?: string[];
  issueUrl?: string;
  executionModeConfig?: { executionMode?: string; overlays?: string[]; risk?: string };
}

export interface WorkerProcessInfo {
  pid: number;
}
