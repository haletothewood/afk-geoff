import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VerificationCommandResult } from "@afk-geoff/shared";
import { resolvePackageManager, runVerificationCommands } from "../local-docker-execution-backend.js";
import { refreshRequirementStatuses } from "../store-helpers.js";
import type { CliContext } from "../types.js";

const execFileAsync = promisify(execFile);

export interface VerificationRetryOutcome {
  runId: string;
  workItemId: string;
  status: "done" | "blocked";
  publishable: boolean;
  reusedStages: string[];
  retriedStages: string[];
  verification: {
    status: "passed" | "failed";
    commands: VerificationCommandResult[];
  };
  finalResultPath: string;
}

export async function retryRunVerification(
  ctx: CliContext,
  runId: string
): Promise<VerificationRetryOutcome> {
  const run = (await ctx.store.listRuns()).find((candidate) => candidate.id === runId);
  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }
  if (!run.worktreePath || !fs.existsSync(run.worktreePath)) {
    throw new Error(`Run ${runId} has no reusable worktree`);
  }

  const finalResultPath = path.join(run.runDir, "final-result.json");
  const finalResult = readJsonRecord(finalResultPath);
  if (!finalResult || finalResult.status !== "blocked") {
    throw new Error(`Run ${runId} is not eligible for verification retry: expected a blocked final result`);
  }

  const reviewResults = getRecordArray(finalResult.reviewResults);
  if (reviewResults.at(-1)?.verdict !== "PASS") {
    throw new Error(`Run ${runId} is not eligible for verification retry: no reusable PASS review`);
  }
  const repeatedFailure = isRecord(finalResult.repeatedFailure) ? finalResult.repeatedFailure : undefined;
  if (repeatedFailure?.kind !== "verification" || typeof repeatedFailure.unchangedHead !== "string") {
    throw new Error(`Run ${runId} is not eligible for verification retry: no unchanged verification failure`);
  }

  const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: run.worktreePath });
  const currentHead = headOutput.trim();
  if (currentHead !== repeatedFailure.unchangedHead) {
    throw new Error(`Run ${runId} is not eligible for verification retry: worktree HEAD changed after review`);
  }
  const { stdout: statusOutput } = await execFileAsync("git", ["status", "--porcelain"], { cwd: run.worktreePath });
  if (statusOutput.trim()) {
    throw new Error(`Run ${runId} is not eligible for verification retry: worktree is dirty`);
  }

  const previousVerification = getRecordArray(finalResult.verificationSummaries);
  const commands = [
    ...new Set(previousVerification.flatMap((summary) =>
      getRecordArray(summary.results)
        .map((result) => result.command)
        .filter((command): command is string => typeof command === "string")
    ))
  ];
  if (commands.length === 0) {
    throw new Error(`Run ${runId} has no recorded verification commands`);
  }

  const packageManager = await resolvePackageManager(run.worktreePath);
  const results = await runVerificationCommands(commands, run.worktreePath, packageManager);
  const passed = results.every((result) => result.passed);
  const iteration = Math.max(0, ...previousVerification.map((summary) =>
    typeof summary.iteration === "number" ? summary.iteration : 0
  )) + 1;
  const verificationSummaries = [
    ...previousVerification,
    {
      iteration,
      recovery: true,
      results: results.map((result) => ({
        command: result.command,
        passed: result.passed,
        exitCode: result.exitCode,
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {})
      }))
    }
  ];
  const recovery = {
    sourceRunId: runId,
    reusedStages: ["work", "review"],
    retriedStages: ["verification"],
    recoveredAt: new Date().toISOString()
  };
  const whyNotPublishable = passed ? [] : results
    .filter((result) => !result.passed)
    .map((result) => `${failureLabel(result)} failed: ${result.command} (exit ${result.exitCode})`);
  const summary = passed
    ? `Verification retry passed on reviewed commit ${currentHead.slice(0, 12)}`
    : `Verification retry failed on reviewed commit ${currentHead.slice(0, 12)}`;
  const evidencePacket = isRecord(finalResult.evidencePacket) ? finalResult.evidencePacket : {};
  const updatedEvidence = {
    ...evidencePacket,
    verification: {
      status: passed ? "passed" : "failed",
      commands: results.map((result) => ({
        command: result.command,
        passed: result.passed,
        exitCode: result.exitCode,
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {})
      }))
    },
    publishability: {
      publishable: passed,
      blockers: passed ? [] : whyNotPublishable.map((message) => ({ category: "verification", message }))
    },
    recommendedHumanAction: passed ? "publish" : "retry",
    recovery
  };
  fs.writeFileSync(finalResultPath, JSON.stringify({
    ...finalResult,
    status: passed ? "done" : "blocked",
    summary,
    verificationSummaries,
    publishable: passed,
    whyNotPublishable,
    publishabilityBlockers: updatedEvidence.publishability.blockers,
    recovery,
    evidencePacket: updatedEvidence
  }, null, 2));

  await ctx.store.updateRun(runId, { status: "completed", summary });
  await ctx.store.updateWorkItemStatus(run.workItemId, passed ? "done" : "blocked");
  await refreshRequirementStatuses(ctx);

  return {
    runId,
    workItemId: run.workItemId,
    status: passed ? "done" : "blocked",
    publishable: passed,
    reusedStages: recovery.reusedStages,
    retriedStages: recovery.retriedStages,
    verification: { status: passed ? "passed" : "failed", commands: results },
    finalResultPath
  };
}

function failureLabel(result: VerificationCommandResult): string {
  return result.failureCategory === "environment"
    ? "Environment verification"
    : result.failureCategory === "verification"
      ? "Verification contract"
      : "Product verification";
}

function readJsonRecord(filename: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function getRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
