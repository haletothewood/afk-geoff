import { commandExistsError, withCommandOverride, withRequiredEnv } from "../cli-utils.js";
import type { CliContext } from "../types.js";

export async function runDoctor(ctx: CliContext): Promise<void> {
  const report = await getDoctorReport(ctx);

  for (const check of report.checks) {
    console.log(`${check.ok ? "OK" : "FAIL"} ${check.label}: ${check.ok ? check.detail : check.error}`);
  }

  if (!report.ok) {
    throw new Error(`Doctor checks failed (${report.failures.length} issue${report.failures.length === 1 ? "" : "s"})`);
  }

  console.log("Doctor checks passed");
}

export interface DoctorReport {
  ok: boolean;
  checks: Array<{ label: string; ok: true; detail: string } | { label: string; ok: false; error: string }>;
  failures: string[];
  commitSigningPolicy: CliContext["commitSigningPolicy"];
}

export async function getDoctorReport(ctx: CliContext): Promise<DoctorReport> {
  const checks: Array<[string, string]> = [
    ["git", "git"],
    ["runner", ctx.runner.buildInvocation({ mode: "work", promptPath: "/tmp/prompt.md", ...withCommandOverride(ctx.config.runner.command) }).command]
  ];
  const results: DoctorReport["checks"] = [];

  if (ctx.executionBackendKind === "local-docker") {
    checks.splice(1, 0, ["docker", "docker"]);
  }

  if (ctx.config.github.enabled) {
    checks.push(["gh", "gh"]);
  }

  for (const [label, executable] of checks) {
    const error = await commandExistsError(executable, label);

    if (error) {
      results.push({ label, ok: false, error });
      continue;
    }

    results.push({ label, ok: true, detail: executable });
  }

  for (const envVar of ctx.runner.requiredEnvVars(withRequiredEnv(ctx.config.runner.requiredEnv))) {
    if (!process.env[envVar]) {
      const error = `Missing required env var ${envVar}`;
      results.push({ label: `env:${envVar}`, ok: false, error });
      continue;
    }

    results.push({ label: `env:${envVar}`, ok: true, detail: "present" });
  }

  if (ctx.config.github.enabled && !ctx.remote) {
    const error = "GitHub is enabled but origin remote owner/repo could not be resolved.";
    results.push({ label: "github", ok: false, error });
  } else if (ctx.config.github.enabled && ctx.remote) {
    results.push({ label: "github remote", ok: true, detail: `${ctx.remote.owner}/${ctx.remote.repo}` });
  }

  if (!ctx.commitSigningPolicy.publishable) {
    results.push({
      label: "commit signing policy",
      ok: false,
      error: ctx.commitSigningPolicy.failure?.message ?? "Commit signing policy is not satisfied"
    });
  } else {
    results.push({
      label: "commit signing policy",
      ok: true,
      detail: `${ctx.commitSigningPolicy.requirement}; ${ctx.commitSigningPolicy.enforced ? `verified ${ctx.commitSigningPolicy.capability.format} capability` : "signing not required"}`
    });
  }

  const failures = results.flatMap((result) => result.ok ? [] : [result.error]);
  return {
    ok: failures.length === 0,
    checks: results,
    failures,
    commitSigningPolicy: ctx.commitSigningPolicy
  };
}
