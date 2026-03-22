import type { CliContext } from "../types.js";

export async function printRuns(ctx: CliContext): Promise<void> {
  const runs = await ctx.store.listRuns();
  console.log("Runs");
  for (const run of runs) {
    console.log(`- ${run.id}  ${run.mode}  ${run.status}  ${run.workItemId}`);
    console.log(`  run dir: ${run.runDir}`);
    if (run.worktreePath) {
      console.log(`  worktree: ${run.worktreePath}`);
    }
    if (run.summary) {
      console.log(`  summary: ${run.summary}`);
    }
  }
}
