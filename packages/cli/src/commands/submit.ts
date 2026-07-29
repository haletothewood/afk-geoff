import type { WorkflowDispatcher } from "@afk-geoff/core";
import { createId } from "@afk-geoff/shared";
import type { CliContext } from "../types.js";

const AFK_RUN_WORKFLOW_ID = "afk-run.yml";
const DEFAULT_AFK_REPOSITORY = "haletothewood/afk-geoff";
const DEFAULT_AFK_REF = "main";

export interface SubmitWorkflowOutcome {
  backend: "github-actions";
  workflowId: string;
  ref: string;
  correlationId: string;
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

  const remote = ctx.remote;
  const dispatcher = asWorkflowDispatcher(ctx.github);
  if (!dispatcher) {
    throw new Error("GitHub Actions submission requires a GitHub adapter that can dispatch workflows.");
  }

  const requirePullRequest = options.requirePullRequest ?? true;
  const afkRepository = options.afkRepository ?? DEFAULT_AFK_REPOSITORY;
  const afkRef = options.afkRef ?? DEFAULT_AFK_REF;
  const correlationId = createId("dispatch");
  const inputs: Record<string, string> = {
    correlation_id: correlationId,
    issue_url: issueUrl,
    backend: "local-docker",
    require_pr: String(requirePullRequest),
    afk_repository: afkRepository,
    afk_ref: afkRef
  };

  const dispatch = () => dispatcher.dispatchWorkflow({
    owner: remote.owner,
    repo: remote.repo,
    workflowId: AFK_RUN_WORKFLOW_ID,
    ref: ctx.config.baseBranch,
    inputs
  });

  try {
    await dispatch();
  } catch (error) {
    if (!isUnsupportedCorrelationInput(error)) {
      throw error;
    }

    throw new Error(
      "The remote afk-run.yml workflow does not accept the required correlation_id input. Upgrade the workflow before submitting GitHub Actions runs."
    );
  }

  return {
    backend: "github-actions",
    workflowId: AFK_RUN_WORKFLOW_ID,
    ref: ctx.config.baseBranch,
    correlationId,
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

function isUnsupportedCorrelationInput(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const status = "status" in error ? error.status : undefined;
  const message = "message" in error ? error.message : undefined;
  return status === 422 &&
    typeof message === "string" &&
    message.startsWith("Unexpected inputs provided:") &&
    message.includes("correlation_id");
}
