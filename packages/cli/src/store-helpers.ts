import fs from "node:fs";
import path from "node:path";
import { summarizeRequirementStatus } from "@afk-geoff/core";
import type { FailureCategory, HydratedWorkItem, Requirement, TerminalFailure } from "@afk-geoff/core";
import { delay, processExists, readWorkerProcessInfo } from "./cli-utils.js";
import type { CliContext } from "./types.js";

export async function mustGetRequirement(ctx: CliContext, requirementId: string): Promise<Requirement> {
  const requirement = await ctx.store.getRequirement(requirementId);

  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`);
  }

  return requirement;
}

export async function mustGetWorkItem(ctx: CliContext, workItemId: string): Promise<HydratedWorkItem> {
  const item = await ctx.store.getWorkItem(workItemId);

  if (!item) {
    throw new Error(`Work item ${workItemId} not found`);
  }

  return item;
}

export async function latestRunForWorkItem(ctx: CliContext, workItemId: string) {
  const runs = await ctx.store.listRuns();
  return runs
    .filter((run) => run.workItemId === workItemId && run.mode === "work")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export async function refreshRequirementStatuses(ctx: CliContext): Promise<void> {
  const requirements = await ctx.store.listRequirements();

  for (const requirement of requirements) {
    const items = await ctx.store.listWorkItemsByRequirement(requirement.id);
    const nextStatus = summarizeRequirementStatus(items);

    if (nextStatus !== requirement.status) {
      await ctx.store.updateRequirementStatus(requirement.id, nextStatus);
    }
  }
}

export async function markWorkItemRunFailed(
  ctx: CliContext,
  workItemId: string,
  summary: string,
  category: Extract<FailureCategory, "orchestrator" | "publishing"> = "orchestrator"
): Promise<void> {
  await ctx.store.updateWorkItemStatus(workItemId, "failed");
  const latestRun = await latestRunForWorkItem(ctx, workItemId);
  if (latestRun) {
    await markRunFailed(ctx, latestRun, summary, category);
  }
  await refreshRequirementStatuses(ctx);
}

export async function markRunFailed(
  ctx: CliContext,
  run: Awaited<ReturnType<CliContext["store"]["listRuns"]>>[number],
  summary: string,
  category: Extract<FailureCategory, "orchestrator" | "publishing"> = "orchestrator"
): Promise<void> {
  const terminalFailure: TerminalFailure = { category, message: summary };
  await ctx.store.updateRun(run.id, { status: "failed", summary, terminalFailure });
  writeTerminalFailure(run.runDir, terminalFailure);
}

function writeTerminalFailure(runDir: string, terminalFailure: TerminalFailure): void {
  const finalResultPath = path.join(runDir, "final-result.json");
  const finalResult = readJsonObject(finalResultPath) ?? {
    status: "failed",
    publishable: false,
    whyNotPublishable: [terminalFailure.message]
  };
  const blocker = {
    category: terminalFailure.category,
    message: terminalFailure.message
  };
  const whyNotPublishable = uniqueStrings([
    ...getStringArray(finalResult.whyNotPublishable),
    terminalFailure.message
  ]);
  const publishabilityBlockers = uniqueBlockers([
    ...getBlockers(finalResult.publishabilityBlockers),
    blocker
  ]);
  const existingEvidencePacket = isJsonObject(finalResult.evidencePacket)
    ? finalResult.evidencePacket
    : {};
  const existingPublishability = isJsonObject(existingEvidencePacket.publishability)
    ? existingEvidencePacket.publishability
    : {};
  const evidencePacket = {
    ...existingEvidencePacket,
    terminalFailure,
    publishability: {
      ...existingPublishability,
      publishable: false,
      blockers: uniqueBlockers([
        ...getBlockers(existingPublishability.blockers),
        blocker
      ])
    },
    recommendedHumanAction: "retry"
  };

  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    finalResultPath,
    JSON.stringify({
      ...finalResult,
      status: "failed",
      publishable: false,
      whyNotPublishable,
      publishabilityBlockers,
      terminalFailure,
      evidencePacket
    }, null, 2)
  );
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function getBlockers(value: unknown): Array<{ category: string; message: string }> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is { category: string; message: string } =>
          isJsonObject(entry)
          && typeof entry.category === "string"
          && typeof entry.message === "string"
      )
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueBlockers(
  blockers: Array<{ category: string; message: string }>
): Array<{ category: string; message: string }> {
  return [...new Map(
    blockers.map((blocker) => [`${blocker.category}\u0000${blocker.message}`, blocker])
  ).values()];
}

function readJsonObject(filename: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filename)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function terminateRunWorker(runDir: string): Promise<void> {
  const processInfo = readWorkerProcessInfo(runDir);
  if (!processInfo) {
    return;
  }

  const { pid } = processInfo;
  if (!processExists(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await delay(200);
  if (processExists(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // best-effort cleanup
    }
  }
}
