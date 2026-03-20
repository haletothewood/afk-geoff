import type { AgentRunner } from "@afk-geoff/core";

export class CodexCliRunner implements AgentRunner {
  public readonly kind = "codex" as const;

  public requiredEnvVars(input?: { requiredEnv?: string[] }): string[] {
    return input?.requiredEnv ?? ["OPENAI_API_KEY"];
  }

  public buildInvocation(input: { mode: "plan" | "work"; promptPath: string; commandOverride?: string[] }): { command: string; args: string[] } {
    return resolveCommand(input.commandOverride ?? ["codex", "{prompt}"], input.promptPath);
  }

  public buildReviewCommand(input: { briefPath: string; reviewCommandOverride?: string[]; commandOverride?: string[] }): string[] {
    return resolveCommandParts(input.reviewCommandOverride ?? input.commandOverride ?? ["codex", "{prompt}"], input.briefPath);
  }
}

function resolveCommand(template: string[], promptPath: string): { command: string; args: string[] } {
  const resolved = resolveCommandParts(template, promptPath);
  return { command: resolved[0]!, args: resolved.slice(1) };
}

function resolveCommandParts(template: string[], promptPath: string): string[] {
  const hasPlaceholder = template.some((part) => part.includes("{prompt}"));
  const resolved = template.map((part) => part.replaceAll("{prompt}", promptPath));
  return hasPlaceholder ? resolved : [...resolved, promptPath];
}
