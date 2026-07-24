import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "@afk-geoff/core";
import { processExists, readDetachedProcessInfo, readRunProgress } from "./cli-utils.js";

export interface RunDiagnostics {
  detachProcessPid?: number;
  detachProcessAlive?: boolean;
  worktreeExists?: boolean;
  runDirExists: boolean;
  resultExists: boolean;
  finalResultExists: boolean;
  lastProgressAgeSeconds?: number;
  detachLogPaths?: {
    stdout: string;
    stderr: string;
  };
}

export type RunRecordWithDiagnostics = RunRecord & { diagnostics: RunDiagnostics };

export function withRunDiagnostics(run: RunRecord): RunRecordWithDiagnostics {
  return { ...run, diagnostics: getRunDiagnostics(run) };
}

export function getRunDiagnostics(run: RunRecord): RunDiagnostics {
  const detachedProcess = readDetachedProcessInfo(run.runDir);
  const progress = readRunProgress(run.runDir);
  const detachStdoutPath = path.join(run.runDir, "detach-stdout.log");
  const detachStderrPath = path.join(run.runDir, "detach-stderr.log");

  return {
    ...(detachedProcess ? { detachProcessPid: detachedProcess.pid, detachProcessAlive: processExists(detachedProcess.pid) } : {}),
    ...(run.worktreePath ? { worktreeExists: fs.existsSync(run.worktreePath) } : {}),
    runDirExists: fs.existsSync(run.runDir),
    resultExists: fs.existsSync(path.join(run.runDir, "result.json")),
    finalResultExists: fs.existsSync(path.join(run.runDir, "final-result.json")),
    ...(progress ? { lastProgressAgeSeconds: Math.max(0, Math.round((Date.now() - new Date(progress.updatedAt).getTime()) / 1000)) } : {}),
    ...(fs.existsSync(detachStdoutPath) || fs.existsSync(detachStderrPath)
      ? { detachLogPaths: { stdout: detachStdoutPath, stderr: detachStderrPath } }
      : {})
  };
}
