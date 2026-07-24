import fs from "node:fs";
import path from "node:path";
import { evaluateNextStatus } from "@afk-geoff/core";
import type { Requirement } from "@afk-geoff/core";
import { processExists, readDetachedProcessInfo, readRunProgress } from "./cli-utils.js";
import { refreshRequirementStatuses, terminateRunWorker } from "./store-helpers.js";
import type { CliContext } from "./types.js";

export async function autoSync(ctx: CliContext): Promise<void> {
  if (ctx.github && ctx.remote) {
    const issueRefs = await ctx.store.listExternalRefs(undefined, "issue");
    const pullRefs = await ctx.store.listExternalRefs("work_item", "pull_request");
    const issueSync = await ctx.github.syncIssues({
      owner: ctx.remote.owner,
      repo: ctx.remote.repo,
      refs: issueRefs
    });

    for (const record of issueSync) {
      await ctx.store.saveSyncState({
        externalRefId: record.refId,
        payload: record
      });
    }

    const prSync = await ctx.github.syncPullRequests({
      owner: ctx.remote.owner,
      repo: ctx.remote.repo,
      refs: pullRefs
    });

    for (const record of prSync) {
      await ctx.store.saveSyncState({
        externalRefId: record.refId,
        payload: record
      });
      const ref = pullRefs.find((item) => item.id === record.refId);

      if (!ref) {
        continue;
      }

      if (record.merged) {
        await ctx.store.updateWorkItemStatus(ref.entityId, "done");
      } else if (record.state === "closed") {
        const workItem = await ctx.store.getWorkItem(ref.entityId);
        if (workItem && workItem.status === "in_progress") {
          await ctx.store.updateWorkItemStatus(ref.entityId, "failed");
        }
      }
    }
  }

  await reconcileLocalRuns(ctx);

  const items = await ctx.store.listWorkItems();
  const itemMap = new Map(items.map((item) => [item.id, item]));

  for (const item of items) {
    const nextStatus = evaluateNextStatus(item, itemMap);

    if (nextStatus !== item.status) {
      await ctx.store.updateWorkItemStatus(item.id, nextStatus);
    }
  }

  await refreshRequirementStatuses(ctx);
  await mirrorActionableWorkItems(ctx);
}

export async function reconcileLocalRuns(ctx: CliContext): Promise<void> {
  const runs = await ctx.store.listRuns();
  const now = Date.now();
  const { runTimeoutMs, heartbeatStaleMs } = ctx.config.timeouts;

  for (const run of runs) {
    if (run.status !== "running") {
      continue;
    }

    if (!fs.existsSync(run.runDir)) {
      await ctx.store.updateRun(run.id, {
        status: "failed",
        summary: "Run directory missing; treating interrupted run as failed"
      });

      const workItem = await ctx.store.getWorkItem(run.workItemId);
      if (workItem?.status === "in_progress") {
        await ctx.store.updateWorkItemStatus(run.workItemId, "failed");
      }

      continue;
    }

    const detachedProcessInfo = readDetachedProcessInfo(run.runDir);
    const finalResultExists = fs.existsSync(path.join(run.runDir, "final-result.json"));
    if (detachedProcessInfo && !processExists(detachedProcessInfo.pid) && !finalResultExists) {
      await ctx.store.updateRun(run.id, {
        status: "failed",
        summary: `Detached worker process ${detachedProcessInfo.pid} exited before completing run artifacts`
      });

      const workItem = await ctx.store.getWorkItem(run.workItemId);
      if (workItem?.status === "in_progress") {
        await ctx.store.updateWorkItemStatus(run.workItemId, "failed");
      }

      continue;
    }

    const runAgeMs = now - new Date(run.createdAt).getTime();
    if (runAgeMs > runTimeoutMs) {
      await terminateRunWorker(run.runDir);
      const ageSeconds = Math.round(runAgeMs / 1000);
      const limitSeconds = Math.round(runTimeoutMs / 1000);
      await ctx.store.updateRun(run.id, {
        status: "failed",
        summary: `Run timeout exceeded: run active for ${ageSeconds}s (limit: ${limitSeconds}s)`
      });

      const workItem = await ctx.store.getWorkItem(run.workItemId);
      if (workItem?.status === "in_progress") {
        await ctx.store.updateWorkItemStatus(run.workItemId, "failed");
      }

      continue;
    }

    const progress = readRunProgress(run.runDir);
    if (progress) {
      const heartbeatAgeMs = now - new Date(progress.updatedAt).getTime();
      if (heartbeatAgeMs > heartbeatStaleMs) {
        await terminateRunWorker(run.runDir);
        const ageSeconds = Math.round(heartbeatAgeMs / 1000);
        const limitSeconds = Math.round(heartbeatStaleMs / 1000);
        await ctx.store.updateRun(run.id, {
          status: "failed",
          summary: `Heartbeat stale: progress not updated for ${ageSeconds}s (limit: ${limitSeconds}s)`
        });

        const workItem = await ctx.store.getWorkItem(run.workItemId);
        if (workItem?.status === "in_progress") {
          await ctx.store.updateWorkItemStatus(run.workItemId, "failed");
        }

        continue;
      }
    }
  }
}

export async function mirrorRequirement(ctx: CliContext, requirement: Requirement): Promise<void> {
  if (!ctx.github || !ctx.remote) {
    return;
  }

  const existing = await ctx.store.getExternalRefForEntity("requirement", requirement.id, "issue");

  if (existing) {
    return;
  }

  const ref = await ctx.github.mirrorRequirement({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    requirement
  });
  await ctx.store.saveExternalRef(ref);
}

export async function mirrorActionableWorkItems(ctx: CliContext): Promise<void> {
  if (!ctx.github || !ctx.remote) {
    return;
  }

  const requirements = new Map((await ctx.store.listRequirements()).map((requirement) => [requirement.id, requirement]));
  const items = await ctx.store.listWorkItems();

  for (const item of items) {
    if (item.status !== "todo" && item.status !== "hitl_pending") {
      continue;
    }

    const existing = await ctx.store.getExternalRefForEntity("work_item", item.id, "issue");

    if (existing) {
      continue;
    }

    const requirement = requirements.get(item.requirementId);

    if (!requirement) {
      continue;
    }

    const ref = await ctx.github.mirrorWorkItem({
      owner: ctx.remote.owner,
      repo: ctx.remote.repo,
      workItem: item,
      requirement
    });
    await ctx.store.saveExternalRef(ref);
  }
}
