import type { AgentRunner } from "@afk-geoff/core";

export class ClaudeCliRunner implements AgentRunner {
  public readonly kind = "claude" as const;

  public requiredEnvVars(input?: { requiredEnv?: string[] }): string[] {
    return input?.requiredEnv ?? ["CLAUDE_CODE_OAUTH_TOKEN"];
  }

  public buildInvocation(input: {
    mode: "plan" | "work";
    promptPath: string;
    commandOverride?: string[];
    model?: string;
  }): { command: string; args: string[]; promptTransport: "arg" | "stdin" } {
    if (input.commandOverride) {
      if (input.model) {
        console.warn("runner.command override is set; runner.model is ignored for this invocation");
      }
      return { ...resolveCommand(input.commandOverride, input.promptPath), promptTransport: "arg" };
    }

    return {
      command: "claude",
      args: [
        "--print",
        "--bare",
        "--permission-mode",
        "bypassPermissions",
        ...(input.model ? ["--model", input.model] : [])
      ],
      promptTransport: "stdin"
    };
  }

  public buildReviewCommand(input: { briefPath: string; reviewCommandOverride?: string[]; commandOverride?: string[]; model?: string }): string[] {
    return resolveCommandParts(input.reviewCommandOverride ?? input.commandOverride ?? ["claude", "{prompt}"], input.briefPath);
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
