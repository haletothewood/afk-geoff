import fs from "node:fs";
import { Command } from "commander";
import { LocalGitCodeHost } from "@afk-geoff/adapter-local-git";
import { configFilePath, writeDefaultProjectFiles } from "@afk-geoff/shared";
import { openContext } from "./context.js";
import { runDoctor } from "./commands/doctor.js";
import { captureRequirement } from "./commands/capture.js";
import { printStatus } from "./commands/status.js";
import { showEntity } from "./commands/show.js";
import { printRuns } from "./commands/runs.js";
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
import { undoWorkItem } from "./commands/undo.js";
import { cleanupArtifacts } from "./commands/cleanup.js";
import { autoSync } from "./sync.js";
import { assertPullRequestReady, assertRunTargetArguments, runPreflight } from "./preflight.js";
import type { CliDependencies } from "./types.js";

export type { CliDependencies };

export async function runCli(argv = process.argv, dependencies: CliDependencies = {}): Promise<void> {
  const program = new Command();
  program.name("afk").description("afk-geoff orchestrator");

  program
    .command("init")
    .option("--with-overrides", "Create prompt and Docker overrides")
    .action(async (options: { withOverrides?: boolean }) => {
      const git = new LocalGitCodeHost();
      await git.assertRepository(process.cwd());
      const configPath = configFilePath(process.cwd());

      if (fs.existsSync(configPath)) {
        throw new Error(`Config already exists at ${configPath}`);
      }

      writeDefaultProjectFiles(process.cwd(), options.withOverrides ?? false);
      console.log(`Initialized .afk in ${process.cwd()}`);
    });

  program.command("doctor").action(async () => {
    const ctx = await openContext(process.cwd(), dependencies);
    await runDoctor(ctx);
  });

  program
    .command("capture")
    .argument("<prompt>", "Requirement prompt")
    .action(async (prompt: string) => {
      const ctx = await openContext(process.cwd(), dependencies);
      const requirement = await captureRequirement(ctx, prompt);
      console.log(`Created requirement ${requirement.id}`);
    });

  program.command("status").action(async () => {
    const ctx = await openContext(process.cwd(), dependencies);
    await autoSync(ctx);
    await printStatus(ctx);
  });

  program
    .command("show")
    .argument("<entityId>", "Requirement id or work item id")
    .action(async (entityId: string) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await autoSync(ctx);
      await showEntity(ctx, entityId);
    });

  program.command("runs").action(async () => {
    const ctx = await openContext(process.cwd(), dependencies);
    await autoSync(ctx);
    await printRuns(ctx);
  });

  program
    .command("logs")
    .argument("<runId>", "Run id")
    .action(async (runId: string) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await printRunLogs(ctx, runId);
    });

  program
    .command("watch")
    .argument("<runId>", "Run id")
    .action(async (runId: string) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await watchRun(ctx, runId, dependencies);
    });

  program
    .command("dispatch")
    .option("--max <count>", "Maximum number of AFK loop iterations", "10")
    .action(async (options: { max: string }) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await dispatchLoop(ctx, Number(options.max));
    });

  program
    .command("run")
    .argument("<target>", "Work item id, or 'file' / 'issue'")
    .argument("[value]", "File path when target is 'file', or GitHub issue URL when target is 'issue'")
    .option("--pr", "Require the run to open a pull request")
    .option("--detach", "Start the run in the background and return immediately with the run id")
    .action(async (target: string, value: string | undefined, options: { pr?: boolean; detach?: boolean }) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await autoSync(ctx);
      if (options.pr) assertPullRequestReady(ctx);
      assertRunTargetArguments(target, value);
      await runPreflight(ctx, { requirePullRequest: options.pr ?? false }, dependencies);

      const prOpts = { requirePullRequest: options.pr ?? false };
      let outcome: { prUrl?: string };

      if (options.detach) {
        if (target === "file") outcome = await runExecutionBriefFileDetached(ctx, value!, dependencies, prOpts);
        else if (target === "issue") outcome = await runGitHubIssueDetached(ctx, value!, dependencies, prOpts);
        else outcome = await runWorkItemDetached(ctx, target, dependencies, prOpts);
      } else {
        if (target === "file") outcome = await runExecutionBriefFile(ctx, value!, prOpts);
        else if (target === "issue") outcome = await runGitHubIssue(ctx, value!, dependencies, prOpts);
        else outcome = await runWorkItem(ctx, target, prOpts);
      }

      if (outcome.prUrl) console.log(`Opened PR: ${outcome.prUrl}`);
    });

  program
    .command("review")
    .argument("<workItemId>", "HITL work item id")
    .action(async (workItemId: string) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await autoSync(ctx);
      await prepareReview(ctx, workItemId);
    });

  program
    .command("undo")
    .argument("<workItemId>", "AFK work item id with an open AFK-created pull request")
    .option("--keep-branch", "Close the pull request but keep the branch and worktree")
    .action(async (workItemId: string, options: { keepBranch?: boolean }) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await autoSync(ctx);
      await undoWorkItem(ctx, workItemId, { deleteBranch: !(options.keepBranch ?? false) });
    });

  program
    .command("cleanup")
    .option("--execute", "Perform actual deletions (default is dry-run)")
    .option("--include-orphans", "Also delete orphaned directories with no matching run record")
    .action(async (options: { execute?: boolean; includeOrphans?: boolean }) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await cleanupArtifacts(ctx, {
        execute: options.execute ?? false,
        includeOrphans: options.includeOrphans ?? false
      });
    });

  program.command("sync").action(async () => {
    const ctx = await openContext(process.cwd(), dependencies);
    await autoSync(ctx);
    console.log("Sync complete");
  });

  await program.parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
