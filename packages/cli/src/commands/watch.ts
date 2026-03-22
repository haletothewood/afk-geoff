import path from "node:path";
import fs from "node:fs";
import { delay, readRunProgress } from "../cli-utils.js";
import type { CliContext, CliDependencies } from "../types.js";

export async function watchRun(ctx: CliContext, runId: string, dependencies: CliDependencies): Promise<void> {
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
    console.log(`Run ${runId} ${run.status}${run.summary ? `: ${run.summary}` : ""}`);
    printNewLogContent("stdout.log", 0, "[stdout]");
    printNewLogContent("stderr.log", 0, "[stderr]");
    return;
  }

  // Active run: stream output and progress until terminal state is reached.
  console.log(`Watching run ${runId} (mode=${run.mode})...`);

  let stdoutOffset = 0;
  let stderrOffset = 0;
  let lastProgressUpdatedAt: string | undefined;
  let staleWarningShown = false;

  while (true) {
    // Stream any new stdout/stderr content.
    stdoutOffset = printNewLogContent("stdout.log", stdoutOffset, "[stdout]");
    stderrOffset = printNewLogContent("stderr.log", stderrOffset, "[stderr]");

    // Display progress update when it changes.
    const progress = readRunProgress(run.runDir);
    if (progress && progress.updatedAt !== lastProgressUpdatedAt) {
      lastProgressUpdatedAt = progress.updatedAt;
      console.log(`[progress] phase=${progress.phase} iteration=${progress.iteration} ${progress.message}`);
    }

    // Warn once if the heartbeat is stale.
    if (progress && !staleWarningShown) {
      const heartbeatAgeMs = Date.now() - new Date(progress.updatedAt).getTime();
      if (heartbeatAgeMs > heartbeatStaleMs) {
        const staleSeconds = Math.round(heartbeatAgeMs / 1000);
        console.log(`Warning: heartbeat stale (last progress update ${staleSeconds}s ago)`);
        staleWarningShown = true;
      }
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
      stdoutOffset = printNewLogContent("stdout.log", stdoutOffset, "[stdout]");
      stderrOffset = printNewLogContent("stderr.log", stderrOffset, "[stderr]");
      console.log(`Run ${runId} ${currentStatus}${currentRun?.summary ? `: ${currentRun.summary}` : ""}`);
      return;
    }

    await delay(pollIntervalMs);
  }
}
