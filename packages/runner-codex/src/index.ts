import type { AgentRunner } from "@afk-geoff/core";

export class CodexCliRunner implements AgentRunner {
  public readonly kind = "codex" as const;

  public requiredEnvVars(input?: { requiredEnv?: string[] }): string[] {
    return input?.requiredEnv ?? ["OPENAI_API_KEY"];
  }

  public buildInvocation(input: {
    mode: "plan" | "work";
    promptPath: string;
    commandOverride?: string[];
    model?: string;
  }): { command: string; args: string[]; promptTransport: "arg" | "stdin" } {
    if (input.commandOverride) {
      const invocation = resolveCommand(input.commandOverride, input.promptPath);
      return { ...invocation, promptTransport: "arg" };
    }

    const modelArgs = input.model ? ["--model", input.model] : [];
    return {
      command: "codex",
      args: ["exec", "--dangerously-bypass-approvals-and-sandbox", ...modelArgs, "-"],
      promptTransport: "stdin"
    };
  }

  public buildReviewCommand(input: { briefPath: string; reviewCommandOverride?: string[]; commandOverride?: string[] }): string[] {
    return resolveCommandParts(input.reviewCommandOverride ?? input.commandOverride ?? ["codex", "{prompt}"], input.briefPath);
  }

  public buildReviewInvocation(input: {
    reviewPromptPath: string;
    reviewCommandOverride?: string[];
    commandOverride?: string[];
    model?: string;
  }): { command: string; args: string[]; promptTransport: "arg" | "stdin" } {
    const effectiveOverride = input.reviewCommandOverride ?? input.commandOverride;
    if (effectiveOverride) {
      return { ...resolveCommand(effectiveOverride, input.reviewPromptPath), promptTransport: "arg" };
    }

    const modelArgs = input.model ? ["--model", input.model] : [];
    return {
      command: "codex",
      args: ["exec", "--dangerously-bypass-approvals-and-sandbox", ...modelArgs, "-"],
      promptTransport: "stdin"
    };
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
