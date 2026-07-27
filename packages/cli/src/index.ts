import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import { configFilePath, runnerProfiles, writeDefaultProjectFiles, writeGitHubActionsWorkflow, writeRunnerProfile, type RunnerProfile } from "@afk-geoff/shared";
import { openContext } from "./context.js";
import { getDoctorReport, runDoctor } from "./commands/doctor.js";
import { captureRequirement } from "./commands/capture.js";
import { getStatusSnapshot, printStatus } from "./commands/status.js";
import { showEntity } from "./commands/show.js";
import { listRunRecords, printRuns } from "./commands/runs.js";
import { inspectRun, printRunInspection } from "./commands/inspect.js";
import { getRunHandoff, printRunHandoff } from "./commands/handoff.js";
import { printRunLogs } from "./commands/logs.js";
import { watchRun } from "./commands/watch.js";
import {
  runWorkItem,
  runExecutionBriefFile,
  runGitHubIssue,
  runWorkItemDetached,
  runExecutionBriefFileDetached,
  runGitHubIssueDetached
} from "./commands/run.js";
import { dispatchLoop } from "./commands/dispatch.js";
import { prepareReview } from "./commands/review.js";
import { runPullRequestFollowUp } from "./commands/follow-up.js";
import { undoWorkItem } from "./commands/undo.js";
import { cleanupArtifacts } from "./commands/cleanup.js";
import { submitGitHubActionsIssueRun } from "./commands/submit.js";
import { listRemoteRuns, printRemoteRuns } from "./commands/remote-runs.js";
import { downloadRemoteArtifact, listRemoteArtifacts, printRemoteArtifactDownload, printRemoteArtifacts } from "./commands/remote-artifacts.js";
import { autoSync } from "./sync.js";
import { assertPullRequestReady, assertRunTargetArguments, runPreflight } from "./preflight.js";
import { formatErrorMessage } from "./cli-utils.js";
import { emitRunEvent, isRunEventLine, withRunEvents } from "./run-events.js";
import type { CliDependencies, RunOutcome } from "./types.js";

const executionBackendChoices = ["local-docker", "local-process"] as const;
const submitBackendChoices = ["github-actions"] as const;

export type { CliDependencies };

export async function runCli(argv = process.argv, dependencies: CliDependencies = {}): Promise<void> {
  const program = new Command();
  const commandCwd = process.env.AFK_CWD ?? process.cwd();
  program.name("afk").description("afk-geoff orchestrator");

  program
    .command("init")
    .option("--with-overrides", "Create prompt and Docker overrides")
    .option("--with-github-actions", "Create the AFK GitHub Actions workflow harness")
    .option("--force-github-actions", "Overwrite an existing AFK GitHub Actions workflow")
    .addOption(new Option("--runner-profile <profile>", "Configure a local runner profile").choices([...runnerProfiles]))
    .action(async (options: { withOverrides?: boolean; withGithubActions?: boolean; forceGithubActions?: boolean; runnerProfile?: RunnerProfile }) => {
      const git = new LocalGitCodeHost();
      await git.assertRepository(commandCwd);
      const configPath = configFilePath(commandCwd);

      if (fs.existsSync(configPath)) {
        if (!options.withGithubActions && !options.runnerProfile) {
          throw new Error(`Config already exists at ${configPath}`);
        }

        if (options.runnerProfile) {
          writeRunnerProfile(commandCwd, options.runnerProfile);
          console.log(`Configured ${options.runnerProfile} runner profile`);
        }

        if (options.withGithubActions) {
          const workflowPath = writeGitHubActionsWorkflow(commandCwd, { overwrite: options.forceGithubActions ?? false });
          console.log(`Created GitHub Actions workflow at ${workflowPath}`);
        }
        return;
      }

      writeDefaultProjectFiles(commandCwd, {
        withOverrides: options.withOverrides ?? false,
        withGitHubActions: options.withGithubActions ?? false,
        overwriteGitHubActions: options.forceGithubActions ?? false,
        ...(options.runnerProfile ? { runnerProfile: options.runnerProfile } : {})
      });
      console.log(`Initialized .afk in ${commandCwd}`);
      if (options.runnerProfile) {
        console.log(`Configured ${options.runnerProfile} runner profile`);
      }
    });

  program.command("doctor")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
    const ctx = await openContext(commandCwd, dependencies);
    if (options.json) {
      const report = await runForJson(async () => await getDoctorReport(ctx));
      printJson({ command: "doctor", backend: ctx.executionBackendKind, ...report });
      if (!report.ok) {
        throw new Error(`Doctor checks failed (${report.failures.length} issue${report.failures.length === 1 ? "" : "s"})`);
      }
    } else {
      await runDoctor(ctx);
    }
  });

  program
    .command("capture")
    .argument("<prompt>", "Requirement prompt")
    .action(async (prompt: string) => {
      const ctx = await openContext(commandCwd, dependencies);
      const requirement = await captureRequirement(ctx, prompt);
      console.log(`Created requirement ${requirement.id}`);
    });

  program.command("status")
    .argument("[workItemId]", "Optional work item id to focus JSON status output")
    .option("--json", "Print machine-readable JSON")
    .action(async (workItemId: string | undefined, options: { json?: boolean }) => {
    const ctx = await openContext(commandCwd, dependencies);
    if (options.json) {
      const snapshot = await runForJson(async () => {
        await autoSync(ctx);
        return await getStatusSnapshot(ctx);
      });
      printJson({
        command: "status",
        backend: ctx.executionBackendKind,
        ...(workItemId ? { workItemId } : {}),
        ...snapshot,
        ...(workItemId ? { focusedWorkItem: snapshot.workItems.find((item) => item.id === workItemId) } : {})
      });
    } else {
      await autoSync(ctx);
      await printStatus(ctx);
    }
  });

  program
    .command("show")
    .argument("<entityId>", "Requirement id or work item id")
    .action(async (entityId: string) => {
      const ctx = await openContext(commandCwd, dependencies);
      await autoSync(ctx);
      await showEntity(ctx, entityId);
    });

  program.command("runs")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
    const ctx = await openContext(commandCwd, dependencies);
    if (options.json) {
      try {
        const runs = await runForJson(async () => {
          await autoSync(ctx);
          return await listRunRecords(ctx);
        });
        printJson({ command: "runs", ok: true, backend: ctx.executionBackendKind, count: runs.length, runs });
      } catch (error) {
        printJson({ command: "runs", ok: false, backend: ctx.executionBackendKind, error: { message: formatErrorMessage(error) } });
        throw error;
      }
    } else {
      await autoSync(ctx);
      await printRuns(ctx);
    }
  });

  program
    .command("inspect")
    .argument("<runId>", "Run id")
    .option("--json", "Print machine-readable JSON")
    .action(async (runId: string, options: { json?: boolean }) => {
      const ctx = await openContext(commandCwd, dependencies);
      if (options.json) {
        try {
          const inspection = await runForJson(async () => {
            await autoSync(ctx);
            return await inspectRun(ctx, runId);
          });
          printJson({ command: "inspect", ok: true, backend: ctx.executionBackendKind, runId, ...inspection });
        } catch (error) {
          printJson({ command: "inspect", ok: false, backend: ctx.executionBackendKind, runId, error: { message: formatErrorMessage(error) } });
          throw error;
        }
      } else {
        await autoSync(ctx);
        await printRunInspection(ctx, runId);
      }
    });

  program
    .command("handoff")
    .argument("<runId>", "Run id")
    .option("--json", "Print machine-readable JSON")
    .action(async (runId: string, options: { json?: boolean }) => {
      const ctx = await openContext(commandCwd, dependencies);
      if (options.json) {
        try {
          const handoff = await runForJson(async () => {
            await autoSync(ctx);
            return await getRunHandoff(ctx, runId);
          });
          printJson({ command: "handoff", ok: true, backend: ctx.executionBackendKind, ...handoff });
        } catch (error) {
          printJson({ command: "handoff", ok: false, backend: ctx.executionBackendKind, runId, error: { message: formatErrorMessage(error) } });
          throw error;
        }
      } else {
        await autoSync(ctx);
        await printRunHandoff(ctx, runId);
      }
    });

  program
    .command("logs")
    .argument("<runId>", "Run id")
    .action(async (runId: string) => {
      const ctx = await openContext(commandCwd, dependencies);
      await printRunLogs(ctx, runId);
    });

  program
    .command("watch")
    .argument("<runId>", "Run id")
    .option("--json", "Print machine-readable JSON/NDJSON")
    .action(async (runId: string, options: { json?: boolean }) => {
      const ctx = await openContext(commandCwd, dependencies);
      if (options.json) {
        let outcome: Awaited<ReturnType<typeof watchRun>>;
        try {
          outcome = await runForJson(async () => await withRunEvents(async () => await watchRun(ctx, runId, dependencies, { json: true })), { allowRunEvents: true });
        } catch (error) {
          printJson({ kind: "watch_result", command: "watch", ok: false, backend: ctx.executionBackendKind, runId, error: { message: formatErrorMessage(error) } }, { compact: true });
          process.exitCode = 1;
          return;
        }
        const ok = outcome.status === "completed";
        printJson({
          kind: "watch_result",
          command: "watch",
          ok,
          backend: ctx.executionBackendKind,
          ...outcome,
          ...(!ok ? { error: { message: outcome.summary ?? `Run ${runId} ${outcome.status}` } } : {})
        }, { compact: true });
        if (!ok) {
          process.exitCode = 1;
        }
      } else {
        await watchRun(ctx, runId, dependencies);
      }
    });

  program
    .command("dispatch")
    .option("--max <count>", "Maximum number of AFK loop iterations", "10")
    .action(async (options: { max: string }) => {
      const ctx = await openContext(commandCwd, dependencies);
      await dispatchLoop(ctx, Number(options.max));
    });

  program
    .command("remote-runs")
    .option("--workflow <workflowId>", "GitHub Actions workflow id", "afk-run.yml")
    .option("--limit <count>", "Maximum number of workflow runs to list", "10")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { workflow: string; limit: string; json?: boolean }) => {
      const ctx = await openContext(commandCwd, dependencies);
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }

      if (options.json) {
        try {
          const snapshot = await runForJson(async () => await listRemoteRuns(ctx, { workflowId: options.workflow, limit }));
          printJson({ command: "remote-runs", ok: true, ...snapshot });
        } catch (error) {
          printJson({ command: "remote-runs", ok: false, workflowId: options.workflow, error: { message: formatErrorMessage(error) } });
          throw error;
        }
      } else {
        await printRemoteRuns(ctx, { workflowId: options.workflow, limit });
      }
    });

  program
    .command("remote-artifacts")
    .argument("<runId>", "GitHub Actions run id")
    .option("--limit <count>", "Maximum number of artifacts to list", "10")
    .option("--json", "Print machine-readable JSON")
    .action(async (runId: string, options: { limit: string; json?: boolean }) => {
      const ctx = await openContext(commandCwd, dependencies);
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      if (!/^\d+$/.test(runId)) {
        throw new Error("runId must be a GitHub Actions numeric run id");
      }

      if (options.json) {
        try {
          const snapshot = await runForJson(async () => await listRemoteArtifacts(ctx, { runId, limit }));
          printJson({ command: "remote-artifacts", ok: true, ...snapshot });
        } catch (error) {
          printJson({ command: "remote-artifacts", ok: false, runId, error: { message: formatErrorMessage(error) } });
          throw error;
        }
      } else {
        await printRemoteArtifacts(ctx, { runId, limit });
      }
    });

  program
    .command("remote-download")
    .argument("<artifactId>", "GitHub Actions artifact id")
    .option("--output <path>", "Path for the downloaded artifact ZIP")
    .option("--json", "Print machine-readable JSON")
    .action(async (artifactId: string, options: { output?: string; json?: boolean }) => {
      const ctx = await openContext(commandCwd, dependencies);
      if (!/^\d+$/.test(artifactId)) {
        throw new Error("artifactId must be a GitHub Actions numeric artifact id");
      }

      if (options.json) {
        try {
          const downloadOptions = options.output ? { artifactId, outputPath: options.output } : { artifactId };
          const result = await runForJson(async () => await downloadRemoteArtifact(ctx, downloadOptions));
          printJson({ command: "remote-download", ok: true, ...result });
        } catch (error) {
          printJson({ command: "remote-download", ok: false, artifactId, error: { message: formatErrorMessage(error) } });
          throw error;
        }
      } else {
        const downloadOptions = options.output ? { artifactId, outputPath: options.output } : { artifactId };
        await printRemoteArtifactDownload(ctx, downloadOptions);
      }
    });

  program
    .command("submit")
    .argument("<target>", "Work source type: issue")
    .argument("<value>", "GitHub issue URL when target is 'issue'")
    .option("--no-pr", "Do not require the remote run to open a pull request")
    .option("--afk-repository <repo>", "AFK Geoff repository for the GitHub Actions worker checkout", "haletothewood/afk-geoff")
    .option("--afk-ref <ref>", "AFK Geoff git ref for the GitHub Actions worker checkout", "main")
    .option("--json", "Print machine-readable JSON")
    .addOption(new Option("--backend <backend>", "Remote execution backend").choices([...submitBackendChoices]).default("github-actions"))
    .action(async (target: string, value: string, options: { pr?: boolean; afkRepository: string; afkRef: string; json?: boolean; backend: typeof submitBackendChoices[number] }) => {
      const ctx = await openContext(commandCwd, dependencies);
      const submitAction = async () => {
        if (target !== "issue") {
          throw new Error("Usage: pnpm afk submit issue <github-issue-url> [--backend github-actions] [--afk-repository owner/repo] [--afk-ref ref] [--json]");
        }
        return await submitGitHubActionsIssueRun(ctx, value, {
          requirePullRequest: options.pr ?? true,
          afkRepository: options.afkRepository,
          afkRef: options.afkRef
        });
      };

      if (options.json) {
        try {
          const outcome = await runForJson(submitAction);
          printJson({ command: "submit", ok: true, target, value, ...outcome });
        } catch (error) {
          printJson({ command: "submit", ok: false, target, value, backend: options.backend, error: { message: formatErrorMessage(error) } });
          throw error;
        }
      } else {
        const outcome = await submitAction();
        console.log(`Submitted ${value} to ${outcome.workflowId} on ${outcome.ref}`);
      }
    });

  program
    .command("run")
    .argument("<target>", "Work item id, or 'file' / 'issue'")
    .argument("[value]", "File path when target is 'file', or GitHub issue URL when target is 'issue'")
    .option("--pr", "Require the run to open a pull request")
    .option("--detach", "Start the run in the background and return immediately with the run id")
    .option("--json", "Print machine-readable JSON")
    .addOption(new Option("--backend <backend>", "Execution backend").choices([...executionBackendChoices]))
    .action(async (target: string, value: string | undefined, options: { pr?: boolean; detach?: boolean; json?: boolean; backend?: typeof executionBackendChoices[number] }) => {
      const ctx = await openContext(commandCwd, { ...dependencies, ...(options.backend ? { backendOverride: options.backend } : {}) });
      const runAction = async () => {
        await autoSync(ctx);
        if (options.pr) assertPullRequestReady(ctx);
        assertRunTargetArguments(target, value);
        await runPreflight(ctx, { requirePullRequest: options.pr ?? false }, dependencies);

        const prOpts = { requirePullRequest: options.pr ?? false };
        let outcome: RunOutcome;

        if (options.detach) {
          if (target === "file") outcome = await runExecutionBriefFileDetached(ctx, value!, dependencies, prOpts);
          else if (target === "issue") outcome = await runGitHubIssueDetached(ctx, value!, dependencies, prOpts);
          else outcome = await runWorkItemDetached(ctx, target, dependencies, prOpts);
        } else {
          if (target === "file") outcome = await runExecutionBriefFile(ctx, value!, prOpts);
          else if (target === "issue") outcome = await runGitHubIssue(ctx, value!, dependencies, prOpts);
          else outcome = await runWorkItem(ctx, target, prOpts);
        }

        return outcome;
      };

      if (options.json) {
        try {
          const outcome = await runForJson(async () => await withRunEvents(async () => {
            emitRunEvent({ event: "run_requested", target, ...(value ? { value } : {}) });
            return await runAction();
          }), { allowRunEvents: true });
          printJson({ kind: "run_result", command: "run", ok: true, target, ...(value ? { value } : {}), backend: ctx.executionBackendKind, requirePullRequest: options.pr ?? false, detached: options.detach ?? false, ...outcome }, { compact: true });
        } catch (error) {
          printJson({ kind: "run_result", command: "run", ok: false, target, ...(value ? { value } : {}), backend: ctx.executionBackendKind, requirePullRequest: options.pr ?? false, detached: options.detach ?? false, error: { message: formatErrorMessage(error) } }, { compact: true });
          throw error;
        }
      } else {
        const outcome = await runAction();
        printRunOutcome(outcome);
        if (outcome.prUrl) {
          console.log(`Opened PR: ${outcome.prUrl}`);
        }
      }
    });

  program
    .command("review")
    .argument("<workItemId>", "HITL work item id")
    .action(async (workItemId: string) => {
      const ctx = await openContext(commandCwd, dependencies);
      await autoSync(ctx);
      await prepareReview(ctx, workItemId);
    });

  program
    .command("follow-up")
    .argument("<workItemId>", "AFK work item id with an open AFK-created pull request")
    .option("--json", "Print machine-readable JSON")
    .addOption(new Option("--backend <backend>", "Execution backend").choices([...executionBackendChoices]))
    .action(async (workItemId: string, options: { json?: boolean; backend?: typeof executionBackendChoices[number] }) => {
      const ctx = await openContext(commandCwd, { ...dependencies, ...(options.backend ? { backendOverride: options.backend } : {}) });
      const followUpAction = async () => {
        await autoSync(ctx);
        return await runPullRequestFollowUp(ctx, workItemId);
      };
      if (options.json) {
        try {
          const outcome = await runForJson(followUpAction);
          printJson({ command: "follow-up", ok: true, workItemId, backend: ctx.executionBackendKind, ...outcome });
        } catch (error) {
          printJson({ command: "follow-up", ok: false, workItemId, backend: ctx.executionBackendKind, error: { message: formatErrorMessage(error) } });
          throw error;
        }
      } else {
        const outcome = await followUpAction();
        printRunOutcome(outcome);
      }
    });

  program
    .command("undo")
    .argument("<workItemId>", "AFK work item id with an open AFK-created pull request")
    .option("--keep-branch", "Close the pull request but keep the branch and worktree")
    .action(async (workItemId: string, options: { keepBranch?: boolean }) => {
      const ctx = await openContext(commandCwd, dependencies);
      await autoSync(ctx);
      await undoWorkItem(ctx, workItemId, { deleteBranch: !(options.keepBranch ?? false) });
    });

  program
    .command("cleanup")
    .option("--execute", "Perform actual deletions (default is dry-run)")
    .option("--include-orphans", "Also delete orphaned directories with no matching run record")
    .action(async (options: { execute?: boolean; includeOrphans?: boolean }) => {
      const ctx = await openContext(commandCwd, dependencies);
      await cleanupArtifacts(ctx, {
        execute: options.execute ?? false,
        includeOrphans: options.includeOrphans ?? false
      });
    });

  program.command("sync").action(async () => {
    const ctx = await openContext(commandCwd, dependencies);
    await autoSync(ctx);
    console.log("Sync complete");
  });

  await program.parseAsync(argv);
}

async function runForJson<T>(action: () => Promise<T>, options: { allowRunEvents?: boolean } = {}): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    const line = args.map((arg) => String(arg)).join(" ");
    if (options.allowRunEvents && isRunEventLine(line)) {
      originalLog(line);
    }
  };
  console.warn = () => {};
  try {
    return await action();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function printJson(payload: unknown, options: { compact?: boolean } = {}): void {
  console.log(JSON.stringify(payload, null, options.compact ? 0 : 2));
}

function printRunOutcome(outcome: {
  status?: string;
  runId?: string;
  branchName?: string;
  worktreePath?: string;
  runDir?: string;
  resultPath?: string;
  finalResultPath?: string;
  finalVerdict?: string;
}): void {
  if (!outcome.runId) {
    return;
  }

  console.log(`Run ${outcome.status ?? "completed"}: ${outcome.runId}`);
  if (outcome.finalVerdict) console.log(`Final verdict: ${outcome.finalVerdict}`);
  if (outcome.branchName) console.log(`Branch: ${outcome.branchName}`);
  if (outcome.worktreePath) console.log(`Worktree: ${outcome.worktreePath}`);
  if (outcome.finalResultPath) console.log(`Final result: ${outcome.finalResultPath}`);
  if (outcome.resultPath) console.log(`Last worker result: ${outcome.resultPath}`);
  if (outcome.runDir) console.log(`Logs: ${outcome.runDir}`);
}

const isDirectCliExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectCliExecution) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
