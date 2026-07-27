#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const afkBin = readOption("--afk", process.env.AFK_BIN ?? "afk");
const cwd = path.resolve(readOption("--cwd", process.cwd()));
const briefPath = readOption("--brief", args.find((arg) => !arg.startsWith("--")) ?? "brief.md");
const requirePullRequest = args.includes("--pr");

try {
  await main();
} catch (error) {
  console.error(`[orchestrator] ${formatError(error)}`);
  process.exit(1);
}

async function main() {
  console.log(`[orchestrator] repo: ${cwd}`);
  console.log(`[orchestrator] brief: ${briefPath}`);
  console.log(`[orchestrator] require PR: ${String(requirePullRequest)}`);

  const doctor = await runJsonCommand(afkCommand("doctor", "--json"));
  if (!doctor.ok) {
    throw new Error(`afk doctor failed: ${(doctor.failures ?? []).join(", ") || "unknown failure"}`);
  }
  console.log(`[orchestrator] doctor ok (${doctor.backend})`);

  const runArgs = ["run", "file", briefPath, "--detach", "--json", ...(requirePullRequest ? ["--pr"] : [])];
  const kickoff = await runNdjsonCommand(afkCommand(...runArgs), {
    onEvent: (event) => logRunEvent(event)
  });
  const runResult = kickoff.at(-1);
  if (!runResult || runResult.kind !== "run_result" || !runResult.ok || !runResult.runId) {
    throw new Error(`detached kickoff failed: ${JSON.stringify(runResult ?? kickoff)}`);
  }
  console.log(`[orchestrator] kicked off ${runResult.runId}`);
  console.log(`[orchestrator] branch: ${runResult.branchName ?? "unknown"}`);
  console.log(`[orchestrator] run dir: ${runResult.runDir ?? "unknown"}`);

  const watch = await runNdjsonCommand(afkCommand("watch", runResult.runId, "--json"), {
    onEvent: (event) => logRunEvent(event),
    allowNonZero: true
  });
  const watchResult = watch.at(-1);
  if (!watchResult || watchResult.kind !== "watch_result") {
    throw new Error(`watch did not produce a watch_result: ${JSON.stringify(watch)}`);
  }

  if (!watchResult.ok) {
    printFailureSummary(watchResult);
    process.exitCode = 1;
    return;
  }

  const inspection = await runJsonCommand(afkCommand("inspect", runResult.runId, "--json"));
  printSuccessSummary(watchResult, inspection);
}

function readOption(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function afkCommand(...commandArgs) {
  return afkBin.endsWith(".js")
    ? [process.execPath, afkBin, ...commandArgs]
    : [afkBin, ...commandArgs];
}

async function runJsonCommand(command) {
  const output = await runCommand(command);
  return JSON.parse(output.stdout);
}

async function runNdjsonCommand(command, options = {}) {
  const output = await runCommand(command, options);
  return output.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runCommand(command, options = {}) {
  const [cmd, ...commandArgs] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          options.onEvent?.(JSON.parse(trimmed));
        } catch {
          // The command contract should keep --json stdout parseable; the final parse will fail loudly.
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !options.allowNonZero) {
        reject(new Error(`${command.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function logRunEvent(event) {
  if (event.kind !== "run_event") {
    return;
  }
  const parts = [
    `[afk] ${event.event}`,
    event.phase ? `phase=${event.phase}` : undefined,
    event.iteration ? `iteration=${event.iteration}` : undefined,
    event.status ? `status=${event.status}` : undefined,
    event.message
  ].filter(Boolean);
  console.log(parts.join(" "));
}

function printSuccessSummary(watchResult, inspection) {
  const finalResult = inspection.finalResult ?? {};
  const derived = inspection.derived ?? {};
  console.log("[orchestrator] completed");
  console.log(`  run: ${watchResult.runId}`);
  console.log(`  branch: ${derived.branchName ?? finalResult.branchName ?? watchResult.branchName ?? "unknown"}`);
  console.log(`  publishable: ${String(derived.publishable ?? finalResult.publishable)}`);
  console.log(`  review: ${derived.reviewVerdict ?? "unknown"}`);
  console.log(`  verification: ${derived.verificationStatus ?? "unknown"}`);
  console.log(`  commits: ${derived.createdCommitCount ?? 0}`);
  console.log(`  worktree clean: ${String(derived.worktreeClean ?? finalResult.worktreeStatus?.clean)}`);
  if (inspection.pullRequest?.url ?? watchResult.prUrl ?? finalResult.prUrl) {
    console.log(`  PR: ${inspection.pullRequest?.url ?? watchResult.prUrl ?? finalResult.prUrl}`);
  }
  console.log(`  final result: ${inspection.paths?.finalResultPath ?? "unknown"}`);
}

function printFailureSummary(watchResult) {
  console.log("[orchestrator] failed");
  console.log(`  run: ${watchResult.runId}`);
  console.log(`  status: ${watchResult.status ?? "failed"}`);
  console.log(`  error: ${watchResult.error?.message ?? watchResult.summary ?? "unknown failure"}`);
  if (watchResult.runDir) {
    console.log(`  run dir: ${watchResult.runDir}`);
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function printUsage() {
  console.log(`Usage: node examples/orchestrator/run-detached.mjs --brief brief.md [--cwd /repo] [--afk afk] [--pr]

Runs AFK Geoff as a backend worker:
  1. afk doctor --json
  2. afk run file <brief> --detach --json [--pr]
  3. afk watch <runId> --json
  4. afk inspect <runId> --json
`);
}
