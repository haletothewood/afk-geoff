import { commandExistsError, withCommandOverride, withRequiredEnv } from "../cli-utils.js";
import type { CliContext } from "../types.js";

export async function runDoctor(ctx: CliContext): Promise<void> {
  const failures: string[] = [];
  const checks: Array<[string, string]> = [
    ["git", "git"],
    ["docker", "docker"],
    ["runner", ctx.runner.buildInvocation({ mode: "work", promptPath: "/tmp/prompt.md", ...withCommandOverride(ctx.config.runner.command) }).command]
  ];

  if (ctx.config.github.enabled) {
    checks.push(["gh", "gh"]);
  }

  for (const [label, executable] of checks) {
    const error = await commandExistsError(executable, label);

    if (error) {
      failures.push(error);
      console.log(`FAIL ${label}: ${error}`);
      continue;
    }

    console.log(`OK ${label}: ${executable}`);
  }

  for (const envVar of ctx.runner.requiredEnvVars(withRequiredEnv(ctx.config.runner.requiredEnv))) {
    if (!process.env[envVar]) {
      const error = `Missing required env var ${envVar}`;
      failures.push(error);
      console.log(`FAIL env:${envVar}: ${error}`);
      continue;
    }

    console.log(`OK env:${envVar}`);
  }

  if (ctx.config.github.enabled && !ctx.remote) {
    const error = "GitHub is enabled but origin remote owner/repo could not be resolved.";
    failures.push(error);
    console.log(`FAIL github: ${error}`);
  } else if (ctx.config.github.enabled && ctx.remote) {
    console.log(`OK github remote: ${ctx.remote.owner}/${ctx.remote.repo}`);
  }

  if (failures.length > 0) {
    throw new Error(`Doctor checks failed (${failures.length} issue${failures.length === 1 ? "" : "s"})`);
  }

  console.log("Doctor checks passed");
}
