import type { AgentRunner, ExecutionBackend, IssueMirror, PullRequestReviewSource, ResultPublisher, SourceUpdater } from "@afk-geoff/core";
import type { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import type { DockerWorkspaceRuntime } from "@afk-geoff/runtime-docker";
import type { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";
import type { ChangeRequestPublisher } from "@afk-geoff/core";

export interface CliContext {
  cwd: string;
  repoRoot: string;
  config: ReturnType<typeof loadProjectConfig>;
  paths: ReturnType<typeof resolveProjectPaths>;
  store: SqliteStateStore;
  git: LocalGitCodeHost;
  runtime: DockerWorkspaceRuntime;
  runner: AgentRunner;
  githubToken: string | undefined;
  github: (IssueMirror & ChangeRequestPublisher & Partial<PullRequestReviewSource>) | undefined;
  executionBackend: ExecutionBackend;
  resultPublisher: ResultPublisher | undefined;
  remote: { owner: string; repo: string } | undefined;
  sourceUpdaterFactory: (issueUrl: string) => SourceUpdater;
}

export interface CliDependencies {
  githubFactory?: (token: string) => IssueMirror & ChangeRequestPublisher & Partial<PullRequestReviewSource>;
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
}

export interface RunOutcome {
  workItemId?: string;
  requirementId?: string;
  runId?: string;
  status?: "completed" | "failed" | "blocked" | "running" | "prepared";
  branchName?: string;
  worktreePath?: string;
  prUrl?: string;
  addressedReviewComments?: number;
}

export interface DetachedRunOptions {
  verification?: string[];
  issueUrl?: string;
  executionModeConfig?: { executionMode?: string; overlays?: string[]; risk?: string };
}

export interface WorkerProcessInfo {
  pid: number;
}
