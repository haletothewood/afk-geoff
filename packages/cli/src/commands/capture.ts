import type { Requirement } from "@afk-geoff/core";
import { createId, deriveTitle } from "@afk-geoff/shared";
import { mirrorRequirement } from "../sync.js";
import type { CliContext } from "../types.js";

export async function captureRequirement(ctx: CliContext, prompt: string): Promise<Requirement> {
  const now = new Date().toISOString();
  const requirement: Requirement = {
    id: createId("req"),
    title: deriveTitle(prompt),
    body: prompt,
    status: "captured",
    createdAt: now,
    updatedAt: now
  };
  await ctx.store.createRequirement(requirement);

  if (ctx.config.github.enabled) {
    await mirrorRequirement(ctx, requirement);
  }

  return requirement;
}
