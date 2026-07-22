import type { WorkflowDispatcher } from "@afk-geoff/core";
import type { CliContext } from "../types.js";

const AFK_RUN_WORKFLOW_ID = "afk-run.yml";
const DEFAULT_AFK_REPOSITORY = "haletothewood/afk-geoff";
const DEFAULT_AFK_REF = "main";

export interface SubmitWorkflowOutcome {
  backend: "github-actions";
  workflowId: string;
  ref: string;
  issueUrl: string;
  requirePullRequest: boolean;
  inputs: Record<string, string>;
}

export async function submitGitHubActionsIssueRun(
  ctx: CliContext,
  issueUrl: string,
  options: { requirePullRequest?: boolean; afkRepository?: string; afkRef?: string } = {}
): Promise<SubmitWorkflowOutcome> {
  if (!ctx.github || !ctx.remote) {
    throw new Error("GitHub Actions submission requires GitHub to be configured.");
  }

  const dispatcher = asWorkflowDispatcher(ctx.github);
  if (!dispatcher) {
    throw new Error("GitHub Actions submission requires a GitHub adapter that can dispatch workflows.");
  }

  const requirePullRequest = options.requirePullRequest ?? true;
  const afkRepository = options.afkRepository ?? DEFAULT_AFK_REPOSITORY;
  const afkRef = options.afkRef ?? DEFAULT_AFK_REF;
  const inputs = {
    issue_url: issueUrl,
    backend: "local-docker",
    require_pr: String(requirePullRequest),
    afk_repository: afkRepository,
    afk_ref: afkRef
  };

  await dispatcher.dispatchWorkflow({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    workflowId: AFK_RUN_WORKFLOW_ID,
    ref: ctx.config.baseBranch,
    inputs
  });

  return {
    backend: "github-actions",
    workflowId: AFK_RUN_WORKFLOW_ID,
    ref: ctx.config.baseBranch,
    issueUrl,
    requirePullRequest,
    inputs
  };
}

function asWorkflowDispatcher(value: unknown): WorkflowDispatcher | undefined {
  if (
    value &&
    typeof value === "object" &&
    "dispatchWorkflow" in value &&
    typeof (value as { dispatchWorkflow?: unknown }).dispatchWorkflow === "function"
  ) {
    return value as WorkflowDispatcher;
  }

  return undefined;
}
