import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HydratedWorkItem, Requirement, RunProgress } from "@afk-geoff/core";
import type { CliContext, WorkerProcessInfo } from "./types.js";

const execFileAsync = promisify(execFile);

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function allowedEnv(envNames: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const name of envNames) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }

  return env;
}

export function withCommandOverride(commandOverride: string[] | undefined): { commandOverride: string[] } | Record<string, never> {
  return commandOverride ? { commandOverride } : {};
}

export function withRequiredEnv(requiredEnv: string[] | undefined): { requiredEnv: string[] } | Record<string, never> {
  return requiredEnv ? { requiredEnv } : {};
}

export function withReviewCommand(reviewCommandOverride: string[] | undefined): { reviewCommandOverride: string[] } | Record<string, never> {
  return reviewCommandOverride ? { reviewCommandOverride } : {};
}

export function withText<K extends string>(key: K, value: string | undefined): { [P in K]: string } | Record<string, never> {
  return value ? { [key]: value } as { [P in K]: string } : {};
}

export function describeRunnerModel(ctx: CliContext): string {
  const modelLabel = ctx.config.runner.model;
  if (ctx.runner.kind === "claude") {
    return modelLabel ? `Claude CLI (model: ${modelLabel})` : "Claude CLI default (no explicit model configured)";
  }

  if (ctx.runner.kind === "codex") {
    return modelLabel ? `Codex CLI (model: ${modelLabel})` : "Codex CLI default (no explicit model configured)";
  }

  return "Custom command runner";
}

export function printLinesOrNone(lines: string[]): void {
  for (const line of lines.length > 0 ? lines : ["- None"]) {
    console.log(line);
  }
}

export function printNextActionLines(lines: string[]): void {
  console.log("Next");
  printLinesOrNone(lines);
}

export function getGlobalNextActions(requirements: Requirement[], items: HydratedWorkItem[]): string[] {
  const runnable = items.find((item) => item.type === "afk" && item.status === "todo");
  if (runnable) {
    return [`- pnpm afk run ${runnable.id}`];
  }

  const hitl = items.find((item) => item.status === "hitl_pending");
  if (hitl) {
    return [`- pnpm afk show ${hitl.id}`];
  }

  if (requirements.length === 0) {
    return ['- pnpm afk capture "<requirement prompt>"'];
  }

  if (requirements.some((requirement) => requirement.status === "captured")) {
    return ["- Use a planning skill to produce an execution brief, then run `pnpm afk run file <path>`"];
  }

  if (items.length > 0 && items.every((item) => item.status === "done")) {
    return ["- All work items are complete"];
  }

  return ["- No immediate action"];
}

export function getRequirementNextActions(items: HydratedWorkItem[]): string[] {
  if (items.length === 0) {
    return ["- Use a planning skill to create an execution brief, then run `pnpm afk run file <path>`"];
  }

  const runnable = items.find((item) => item.type === "afk" && item.status === "todo");
  if (runnable) {
    return [`- pnpm afk run ${runnable.id}`];
  }

  const hitl = items.find((item) => item.status === "hitl_pending");
  if (hitl) {
    return [`- pnpm afk show ${hitl.id}`];
  }

  if (items.every((item) => item.status === "done")) {
    return ["- Requirement is complete"];
  }

  return ["- No immediate action"];
}

export function getWorkItemNextActions(item: HydratedWorkItem): string[] {
  if (item.type === "afk" && item.status === "todo") {
    return [`- pnpm afk run ${item.id}`];
  }

  if (item.status === "hitl_pending") {
    return ["- Human review required"];
  }

  if (item.status === "blocked") {
    return ["- Waiting for dependencies to complete"];
  }

  if (item.status === "draft") {
    return ["- Legacy draft item; use an external planning skill instead of the removed CLI planner"];
  }

  if (item.status === "done") {
    return ["- Work item is complete"];
  }

  return ["- No immediate action"];
}

export function readRunProgress(runDir: string): RunProgress | undefined {
  const progressPath = path.join(runDir, "progress.json");
  try {
    if (!fs.existsSync(progressPath)) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(progressPath, "utf8")) as RunProgress;
  } catch {
    return undefined;
  }
}

export function readWorkerProcessInfo(runDir: string): WorkerProcessInfo | undefined {
  return readProcessInfoFile(path.join(runDir, "worker-process.json"));
}

export function readDetachedProcessInfo(runDir: string): WorkerProcessInfo | undefined {
  return readProcessInfoFile(path.join(runDir, "detach-process.json"));
}

function readProcessInfoFile(processPath: string): WorkerProcessInfo | undefined {
  try {
    if (!fs.existsSync(processPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(processPath, "utf8")) as Partial<WorkerProcessInfo>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return undefined;
    }
    return { pid: parsed.pid };
  } catch {
    return undefined;
  }
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function commandExistsError(command: string, label: string): Promise<string | undefined> {
  try {
    await execFileAsync("which", [command]);
    return undefined;
  } catch {
    return `Missing ${label} executable: ${command}`;
  }
}

export function buildFallbackSourceComment(payload: { status: "done" | "blocked" | "failed"; summary: string; prUrl?: string }): string {
  const statusLabel = payload.status === "done" ? "completed" : payload.status;
  const lines = [`**AFK run ${statusLabel}**`, "", payload.summary];
  if (payload.prUrl) {
    lines.push("", `Pull request: ${payload.prUrl}`);
  }
  return lines.join("\n");
}
