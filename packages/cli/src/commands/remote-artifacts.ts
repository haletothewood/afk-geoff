import fs from "node:fs/promises";
import path from "node:path";
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

export interface RemoteArtifactDownload {
  artifactId: string;
  outputPath: string;
  bytes: number;
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

export async function downloadRemoteArtifact(
  ctx: CliContext,
  options: { artifactId: string; outputPath?: string }
): Promise<RemoteArtifactDownload> {
  if (!ctx.github || !ctx.remote) {
    throw new Error("Remote artifact download requires GitHub to be configured.");
  }

  const artifactSource = asWorkflowArtifactSource(ctx.github);
  if (!artifactSource) {
    throw new Error("Remote artifact download requires a GitHub adapter that can download workflow artifacts.");
  }

  const bytes = await artifactSource.downloadWorkflowArtifact({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    artifactId: options.artifactId
  });
  const outputPath = options.outputPath
    ? path.resolve(ctx.cwd, options.outputPath)
    : path.join(ctx.repoRoot, ".afk", "remote-artifacts", `${options.artifactId}.zip`);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);

  return {
    artifactId: options.artifactId,
    outputPath,
    bytes: bytes.byteLength
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

export async function printRemoteArtifactDownload(ctx: CliContext, options: { artifactId: string; outputPath?: string }): Promise<void> {
  const result = await downloadRemoteArtifact(ctx, options);
  console.log(`Downloaded artifact ${result.artifactId}`);
  console.log(`- ${result.outputPath}  ${result.bytes} bytes`);
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
