import fs from "node:fs";
import path from "node:path";
import type { CliContext } from "../types.js";

export async function printRunLogs(ctx: CliContext, runId: string): Promise<void> {
  const run = (await ctx.store.listRuns()).find((record) => record.id === runId);

  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }

  const logFiles = [
    { label: "manifest", path: path.join(run.runDir, "manifest.json") },
    { label: "prompt", path: path.join(run.runDir, "prompt.md") },
    { label: "stdout", path: path.join(run.runDir, "stdout.log") },
    { label: "stderr", path: path.join(run.runDir, "stderr.log") },
    { label: "result", path: path.join(run.runDir, "result.json") },
    { label: "review", path: path.join(run.runDir, "review.md") }
  ];

  console.log(`Run ${run.id}`);
  console.log(`Mode: ${run.mode}`);
  console.log(`Status: ${run.status}`);
  console.log(`Run dir: ${run.runDir}`);
  if (run.worktreePath) {
    console.log(`Worktree: ${run.worktreePath}`);
  }

  for (const file of logFiles) {
    if (!fs.existsSync(file.path)) {
      continue;
    }

    console.log("");
    console.log(`== ${file.label}: ${file.path} ==`);
    console.log(fs.readFileSync(file.path, "utf8"));
  }
}
