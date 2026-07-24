import path from "node:path";
import fs from "node:fs";
import { delay, processExists, readDetachedProcessInfo, readRunProgress } from "../cli-utils.js";
import { refreshRequirementStatuses } from "../store-helpers.js";
import type { CliContext, CliDependencies } from "../types.js";
import { emitRunEvent } from "../run-events.js";

export interface WatchRunOutcome {
  runId: string;
  workItemId: string;
  status: string;
  mode: string;
  summary?: string;
  branchName?: string;
  worktreePath?: string;
  runDir: string;
}

export async function watchRun(ctx: CliContext, runId: string, dependencies: CliDependencies, options: { json?: boolean } = {}): Promise<WatchRunOutcome> {
  const allRuns = await ctx.store.listRuns();
  const run = allRuns.find((r) => r.id === runId);

  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }

  const pollIntervalMs = dependencies.watchPollIntervalMs ?? 2000;
  const heartbeatStaleMs = ctx.config.timeouts.heartbeatStaleMs;

  const isTerminal = (status: string) => status === "completed" || status === "failed";

  const printNewLogContent = (logFile: string, offset: number, prefix: string): number => {
    const logPath = path.join(run.runDir, logFile);
    if (!fs.existsSync(logPath)) {
      return offset;
    }
    const content = fs.readFileSync(logPath, "utf8");
    const newContent = content.slice(offset);
    if (newContent.length > 0) {
      for (const line of newContent.split("\n")) {
        if (line.trim().length > 0) {
          console.log(`${prefix} ${line}`);
        }
      }
    }
    return content.length;
  };

  // Already in a terminal state: print accumulated logs and exit zero.
  if (isTerminal(run.status)) {
    if (options.json) {
      emitRunEvent(toWatchEvent("run_observed", run));
    } else {
      console.log(`Run ${runId} ${run.status}${run.summary ? `: ${run.summary}` : ""}`);
      printNewLogContent("stdout.log", 0, "[stdout]");
      printNewLogContent("stderr.log", 0, "[stderr]");
    }
    return toWatchOutcome(run);
  }

  // Active run: stream output and progress until terminal state is reached.
  if (options.json) {
    emitRunEvent(toWatchEvent("watch_started", run));
  } else {
    console.log(`Watching run ${runId} (mode=${run.mode})...`);
  }

  let stdoutOffset = 0;
  let stderrOffset = 0;
  let lastProgressUpdatedAt: string | undefined;
  let staleWarningShown = false;

  while (true) {
    // Stream any new stdout/stderr content.
    if (!options.json) {
      stdoutOffset = printNewLogContent("stdout.log", stdoutOffset, "[stdout]");
      stderrOffset = printNewLogContent("stderr.log", stderrOffset, "[stderr]");
    }

    // Display progress update when it changes.
    const progress = readRunProgress(run.runDir);
    if (progress && progress.updatedAt !== lastProgressUpdatedAt) {
      lastProgressUpdatedAt = progress.updatedAt;
      if (options.json) {
        emitRunEvent({
          event: "progress_observed",
          runId,
          workItemId: run.workItemId,
          phase: progress.phase,
          iteration: progress.iteration,
          message: progress.message
        });
      } else {
        console.log(`[progress] phase=${progress.phase} iteration=${progress.iteration} ${progress.message}`);
      }
    }

    // Warn once if the heartbeat is stale.
    if (progress && !staleWarningShown) {
      const heartbeatAgeMs = Date.now() - new Date(progress.updatedAt).getTime();
      if (heartbeatAgeMs > heartbeatStaleMs) {
        const staleSeconds = Math.round(heartbeatAgeMs / 1000);
        if (options.json) {
          emitRunEvent({
            event: "heartbeat_stale",
            runId,
            workItemId: run.workItemId,
            phase: progress.phase,
            iteration: progress.iteration,
            message: `last progress update ${staleSeconds}s ago`
          });
        } else {
          console.log(`Warning: heartbeat stale (last progress update ${staleSeconds}s ago)`);
        }
        staleWarningShown = true;
      }
    }

    const detachedFailure = await failIfDetachedProcessExited(ctx, runId);
    if (detachedFailure) {
      if (options.json) {
        emitRunEvent(toWatchEvent("run_failed", detachedFailure));
      } else {
        console.log(`Run ${runId} failed: ${detachedFailure.summary ?? "Detached worker exited before completion"}`);
      }
      return toWatchOutcome(detachedFailure);
    }

    // Test hook: allow callers to mutate state between poll and status check.
    if (dependencies.onAfterPoll) {
      await dependencies.onAfterPoll();
    }

    // Re-query the run to detect terminal state transitions.
    const updatedRuns = await ctx.store.listRuns();
    const currentRun = updatedRuns.find((r) => r.id === runId);
    const currentStatus = currentRun?.status ?? "failed";

    if (isTerminal(currentStatus)) {
      // Drain any remaining output written just before completion.
      if (!options.json) {
        stdoutOffset = printNewLogContent("stdout.log", stdoutOffset, "[stdout]");
        stderrOffset = printNewLogContent("stderr.log", stderrOffset, "[stderr]");
        console.log(`Run ${runId} ${currentStatus}${currentRun?.summary ? `: ${currentRun.summary}` : ""}`);
      } else if (currentRun) {
        emitRunEvent(toWatchEvent("run_completed", currentRun));
      }
      return currentRun ? toWatchOutcome(currentRun) : {
        runId,
        workItemId: run.workItemId,
        status: "failed",
        mode: run.mode,
        runDir: run.runDir,
        ...(run.branchName ? { branchName: run.branchName } : {}),
        ...(run.worktreePath ? { worktreePath: run.worktreePath } : {})
      };
    }

    await delay(pollIntervalMs);
  }
}

function toWatchOutcome(run: Awaited<ReturnType<CliContext["store"]["listRuns"]>>[number]): WatchRunOutcome {
  return {
    runId: run.id,
    workItemId: run.workItemId,
    status: run.status,
    mode: run.mode,
    ...(run.summary ? { summary: run.summary } : {}),
    ...(run.branchName ? { branchName: run.branchName } : {}),
    ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
    runDir: run.runDir
  };
}

function toWatchEvent(event: string, run: Awaited<ReturnType<CliContext["store"]["listRuns"]>>[number]) {
  return {
    event,
    runId: run.id,
    workItemId: run.workItemId,
    status: run.status,
    ...(run.summary ? { message: run.summary } : {}),
    ...(run.branchName ? { branchName: run.branchName } : {}),
    ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
    runDir: run.runDir
  };
}

async function failIfDetachedProcessExited(ctx: CliContext, runId: string) {
  const runs = await ctx.store.listRuns();
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run || run.status !== "running") {
    return undefined;
  }

  const processInfo = readDetachedProcessInfo(run.runDir);
  if (!processInfo || processExists(processInfo.pid)) {
    return undefined;
  }

  const finalResultPath = path.join(run.runDir, "final-result.json");
  if (fs.existsSync(finalResultPath)) {
    return undefined;
  }

  const summary = `Detached worker process ${processInfo.pid} exited before completing run artifacts`;
  await ctx.store.updateRun(run.id, { status: "failed", summary });
  await ctx.store.updateWorkItemStatus(run.workItemId, "failed");
  await refreshRequirementStatuses(ctx);

  const updatedRuns = await ctx.store.listRuns();
  return updatedRuns.find((candidate) => candidate.id === runId);
}
