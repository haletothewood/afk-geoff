import type { WorkflowRunSource } from "@afk-geoff/core";
import type { CliContext } from "../types.js";

const AFK_RUN_WORKFLOW_ID = "afk-run.yml";

export interface RemoteRunsSnapshot {
  workflowId: string;
  runs: Array<{
    id: string;
    name?: string;
    status?: string;
    conclusion?: string;
    branch?: string;
    event?: string;
    url?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
}

export async function listRemoteRuns(
  ctx: CliContext,
  options: { workflowId?: string; limit?: number } = {}
): Promise<RemoteRunsSnapshot> {
  if (!ctx.github || !ctx.remote) {
    throw new Error("Remote run listing requires GitHub to be configured.");
  }

  const runSource = asWorkflowRunSource(ctx.github);
  if (!runSource) {
    throw new Error("Remote run listing requires a GitHub adapter that can list workflow runs.");
  }

  const workflowId = options.workflowId ?? AFK_RUN_WORKFLOW_ID;
  const limit = options.limit ?? 10;
  const runs = await runSource.listWorkflowRuns({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    workflowId,
    limit
  });

  return {
    workflowId,
    runs
  };
}

export async function printRemoteRuns(ctx: CliContext, options: { workflowId?: string; limit?: number } = {}): Promise<void> {
  const snapshot = await listRemoteRuns(ctx, options);
  console.log(`Remote runs for ${snapshot.workflowId}`);
  if (snapshot.runs.length === 0) {
    console.log("- None");
    return;
  }

  for (const run of snapshot.runs) {
    console.log(`- ${run.id}  ${run.status ?? "unknown"}${run.conclusion ? `/${run.conclusion}` : ""}${run.url ? `  ${run.url}` : ""}`);
  }
}

function asWorkflowRunSource(value: unknown): WorkflowRunSource | undefined {
  if (
    value &&
    typeof value === "object" &&
    "listWorkflowRuns" in value &&
    typeof (value as { listWorkflowRuns?: unknown }).listWorkflowRuns === "function"
  ) {
    return value as WorkflowRunSource;
  }

  return undefined;
}
