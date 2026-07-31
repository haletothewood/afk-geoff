import fs from "node:fs";
import path from "node:path";
import type { ExternalRef, RunRecord, TerminalFailure } from "@afk-geoff/core";
import { getRunDiagnostics } from "../run-diagnostics.js";
import type { CliContext } from "../types.js";

export interface RunInspection {
  run: RunRecord;
  diagnostics: ReturnType<typeof getRunDiagnostics>;
  paths: {
    runDir: string;
    resultPath?: string;
    finalResultPath?: string;
    worktreePath?: string;
    detachLogPaths?: {
      stdout: string;
      stderr: string;
    };
  };
  finalResult?: Record<string, unknown>;
  evidencePacket?: Record<string, unknown>;
  terminalFailure?: TerminalFailure;
  pullRequest?: ExternalRef;
  derived: {
    complete: boolean;
    publishable?: boolean;
    whyNotPublishable?: string[];
    branchName?: string;
    reviewVerdict?: string;
    verificationStatus: "passed" | "failed" | "skipped" | "unknown";
    createdCommitCount?: number;
    worktreeClean?: boolean;
  };
}

export async function inspectRun(ctx: CliContext, runId: string): Promise<RunInspection> {
  const runs = await ctx.store.listRuns();
  const run = runs.find((candidate) => candidate.id === runId);

  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }

  const diagnostics = getRunDiagnostics(run);
  const resultPath = path.join(run.runDir, "result.json");
  const finalResultPath = path.join(run.runDir, "final-result.json");
  const finalResult = readJsonObject(finalResultPath);
  const evidencePacket = isObject(finalResult?.evidencePacket) ? finalResult.evidencePacket : undefined;
  const pullRequest = await ctx.store.getExternalRefForEntity("work_item", run.workItemId, "pull_request");

  return {
    run,
    diagnostics,
    paths: {
      runDir: run.runDir,
      ...(diagnostics.resultExists ? { resultPath } : {}),
      ...(diagnostics.finalResultExists ? { finalResultPath } : {}),
      ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
      ...(diagnostics.detachLogPaths ? { detachLogPaths: diagnostics.detachLogPaths } : {})
    },
    ...(finalResult ? { finalResult } : {}),
    ...(evidencePacket ? { evidencePacket } : {}),
    ...(run.terminalFailure ? { terminalFailure: run.terminalFailure } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    derived: deriveInspection(run, diagnostics, finalResult)
  };
}

export async function printRunInspection(ctx: CliContext, runId: string): Promise<void> {
  const inspection = await inspectRun(ctx, runId);
  console.log(`Run ${inspection.run.id} ${inspection.run.status}`);
  console.log(`Branch: ${inspection.derived.branchName ?? "unknown"}`);
  console.log(`Publishable: ${inspection.derived.publishable === undefined ? "unknown" : String(inspection.derived.publishable)}`);
  console.log(`Review: ${inspection.derived.reviewVerdict ?? "unknown"}`);
  console.log(`Verification: ${inspection.derived.verificationStatus}`);
  if (inspection.terminalFailure) {
    console.log(`Terminal failure [${inspection.terminalFailure.category}]: ${inspection.terminalFailure.message}`);
  }
  console.log(`Created commits: ${inspection.derived.createdCommitCount ?? 0}`);
  console.log(`Worktree clean: ${inspection.derived.worktreeClean === undefined ? "unknown" : String(inspection.derived.worktreeClean)}`);
  if (typeof inspection.evidencePacket?.recommendedHumanAction === "string") {
    console.log(`Recommended human action: ${inspection.evidencePacket.recommendedHumanAction}`);
  }
  if (inspection.pullRequest?.url) {
    console.log(`Pull request: ${inspection.pullRequest.url}`);
  }
  if (inspection.paths.finalResultPath) {
    console.log(`Final result: ${inspection.paths.finalResultPath}`);
  }
}

function deriveInspection(
  run: RunRecord,
  diagnostics: ReturnType<typeof getRunDiagnostics>,
  finalResult: Record<string, unknown> | undefined
): RunInspection["derived"] {
  const reviewResults = getArray<Record<string, unknown>>(finalResult?.reviewResults);
  const verificationSummaries = getArray<Record<string, unknown>>(finalResult?.verificationSummaries);
  const verificationResults = verificationSummaries.length > 0
    ? getArray<Record<string, unknown>>(verificationSummaries.at(-1)?.results)
    : [];
  const commits = getArray<Record<string, unknown>>(finalResult?.commits);
  const worktreeStatus = isObject(finalResult?.worktreeStatus) ? finalResult.worktreeStatus : undefined;
  const whyNotPublishable = getStringArray(finalResult?.whyNotPublishable);

  return {
    complete: diagnostics.finalResultExists,
    ...(typeof finalResult?.publishable === "boolean" ? { publishable: finalResult.publishable } : {}),
    ...(whyNotPublishable ? { whyNotPublishable } : {}),
    ...(typeof finalResult?.branchName === "string" ? { branchName: finalResult.branchName } : run.branchName ? { branchName: run.branchName } : {}),
    ...(reviewResults.length > 0 && typeof reviewResults.at(-1)?.verdict === "string"
      ? { reviewVerdict: reviewResults.at(-1)!.verdict as string }
      : {}),
    verificationStatus: deriveVerificationStatus(verificationResults),
    ...(commits.length > 0 ? { createdCommitCount: commits.filter((commit) => commit.created === true).length } : {}),
    ...(typeof worktreeStatus?.clean === "boolean" ? { worktreeClean: worktreeStatus.clean } : {})
  };
}

function deriveVerificationStatus(results: Array<Record<string, unknown>>): RunInspection["derived"]["verificationStatus"] {
  if (results.length === 0) {
    return "skipped";
  }

  return results.every((result) => result.passed === true) ? "passed" : "failed";
}

function readJsonObject(filename: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filename)) {
    return undefined;
  }

  const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  return isObject(parsed) ? parsed : undefined;
}

function getArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
