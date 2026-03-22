import { autoSync } from "../sync.js";
import { runTrackedWorkItem } from "./run.js";
import type { CliContext } from "../types.js";

export async function dispatchLoop(ctx: CliContext, maxIterations: number): Promise<void> {
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`--max must be a positive integer, received: ${maxIterations}`);
  }

  let iterations = 0;

  while (iterations < maxIterations) {
    await autoSync(ctx);
    const nextItem = (await ctx.store.listWorkItems()).find((item) => item.type === "afk" && item.status === "todo");

    if (!nextItem) {
      const reason = iterations === 0 ? "no runnable AFK items" : "queue drained";
      console.log(`Dispatch complete after ${iterations} iteration(s): ${reason}`);
      return;
    }

    iterations += 1;
    console.log(`Dispatch iteration ${iterations}/${maxIterations}: ${nextItem.id}  ${nextItem.title}`);
    await runTrackedWorkItem(ctx, nextItem.id);
  }

  console.log(`Dispatch complete after ${iterations} iteration(s): reached loop limit`);
}
