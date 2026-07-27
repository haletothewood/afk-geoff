import type { RunInspection } from "./inspect.js";
import { inspectRun } from "./inspect.js";
import type { CliContext } from "../types.js";

export type RecommendedHandoffAction = "publish" | "report_failure" | "investigate" | "retry";

export interface RunHandoff {
  runId: string;
  workItemId: string;
  status: string;
  recommendedAction: RecommendedHandoffAction;
  branchName?: string;
  pullRequest?: {
    url?: string;
    remoteNumber: number;
  };
  publishable?: boolean;
  whyNotPublishable?: string[];
  reviewVerdict?: string;
  verificationStatus: RunInspection["derived"]["verificationStatus"];
  createdCommitCount?: number;
  worktreeClean?: boolean;
  runDir: string;
  finalResultPath: string;
  worktreePath?: string;
  summary?: string;
}

export async function getRunHandoff(ctx: CliContext, runId: string): Promise<RunHandoff> {
  const inspection = await inspectRun(ctx, runId);
  const { run, derived, paths, pullRequest } = inspection;

  return {
    runId: run.id,
    workItemId: run.workItemId,
    status: run.status,
    recommendedAction: recommendAction(inspection),
    ...(derived.branchName ? { branchName: derived.branchName } : {}),
    ...(pullRequest
      ? {
          pullRequest: {
            ...(pullRequest.url ? { url: pullRequest.url } : {}),
            remoteNumber: pullRequest.remoteNumber
          }
        }
      : {}),
    ...(typeof derived.publishable === "boolean" ? { publishable: derived.publishable } : {}),
    ...(derived.whyNotPublishable ? { whyNotPublishable: derived.whyNotPublishable } : {}),
    ...(derived.reviewVerdict ? { reviewVerdict: derived.reviewVerdict } : {}),
    verificationStatus: derived.verificationStatus,
    ...(typeof derived.createdCommitCount === "number" ? { createdCommitCount: derived.createdCommitCount } : {}),
    ...(typeof derived.worktreeClean === "boolean" ? { worktreeClean: derived.worktreeClean } : {}),
    runDir: paths.runDir,
    finalResultPath: paths.finalResultPath,
    ...(paths.worktreePath ? { worktreePath: paths.worktreePath } : {}),
    ...(run.summary ? { summary: run.summary } : {})
  };
}

export async function printRunHandoff(ctx: CliContext, runId: string): Promise<void> {
  const handoff = await getRunHandoff(ctx, runId);
  console.log(`Run ${handoff.runId} ${handoff.status}`);
  console.log(`Recommended action: ${handoff.recommendedAction}`);
  console.log(`Branch: ${handoff.branchName ?? "unknown"}`);
  if (handoff.pullRequest?.url) {
    console.log(`Pull request: ${handoff.pullRequest.url}`);
  }
  console.log(`Publishable: ${handoff.publishable === undefined ? "unknown" : String(handoff.publishable)}`);
  console.log(`Review: ${handoff.reviewVerdict ?? "unknown"}`);
  console.log(`Verification: ${handoff.verificationStatus}`);
  console.log(`Final result: ${handoff.finalResultPath}`);
}

function recommendAction(inspection: RunInspection): RecommendedHandoffAction {
  if (inspection.run.status === "completed" && inspection.derived.publishable === true) {
    return "publish";
  }

  if (inspection.run.status === "failed") {
    return "retry";
  }

  if (inspection.run.status === "running" || !inspection.derived.complete) {
    return "investigate";
  }

  return "report_failure";
}
