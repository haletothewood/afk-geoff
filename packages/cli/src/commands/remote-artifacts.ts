import type { WorkflowArtifactSource } from "@afk-geoff/core";
import type { CliContext } from "../types.js";

export interface RemoteArtifactsSnapshot {
  runId: string;
  artifacts: Array<{
    id: string;
    name: string;
    sizeInBytes?: number;
    expired?: boolean;
    url?: string;
    archiveDownloadUrl?: string;
    createdAt?: string;
    updatedAt?: string;
    expiresAt?: string;
  }>;
}

export async function listRemoteArtifacts(
  ctx: CliContext,
  options: { runId: string; limit?: number }
): Promise<RemoteArtifactsSnapshot> {
  if (!ctx.github || !ctx.remote) {
    throw new Error("Remote artifact listing requires GitHub to be configured.");
  }

  const artifactSource = asWorkflowArtifactSource(ctx.github);
  if (!artifactSource) {
    throw new Error("Remote artifact listing requires a GitHub adapter that can list workflow artifacts.");
  }

  const limit = options.limit ?? 10;
  const artifacts = await artifactSource.listWorkflowArtifacts({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    runId: options.runId,
    limit
  });

  return {
    runId: options.runId,
    artifacts
  };
}

export async function printRemoteArtifacts(ctx: CliContext, options: { runId: string; limit?: number }): Promise<void> {
  const snapshot = await listRemoteArtifacts(ctx, options);
  console.log(`Remote artifacts for run ${snapshot.runId}`);
  if (snapshot.artifacts.length === 0) {
    console.log("- None");
    return;
  }

  for (const artifact of snapshot.artifacts) {
    const size = artifact.sizeInBytes === undefined ? "" : `  ${artifact.sizeInBytes} bytes`;
    const expired = artifact.expired ? "  expired" : "";
    console.log(`- ${artifact.id}  ${artifact.name}${size}${expired}${artifact.archiveDownloadUrl ? `  ${artifact.archiveDownloadUrl}` : ""}`);
  }
}

function asWorkflowArtifactSource(value: unknown): WorkflowArtifactSource | undefined {
  if (
    value &&
    typeof value === "object" &&
    "listWorkflowArtifacts" in value &&
    typeof (value as { listWorkflowArtifacts?: unknown }).listWorkflowArtifacts === "function"
  ) {
    return value as WorkflowArtifactSource;
  }

  return undefined;
}
