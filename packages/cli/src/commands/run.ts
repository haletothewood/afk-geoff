import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { GitHubIssueWorkSource } from "@afk-geoff/adapter-github";
import { branchNameForWorkItem } from "@afk-geoff/adapter-local-git";
import { createId, deriveTitle, slugify } from "@afk-geoff/shared";
import type { Requirement } from "@afk-geoff/core";
import { buildFallbackSourceComment, describeRunnerModel, formatErrorMessage } from "../cli-utils.js";
import { NoOpSourceUpdater, tryPostSourceUpdate } from "../source-updater.js";
import { latestRunForWorkItem, markWorkItemRunFailed, mustGetRequirement, mustGetWorkItem, refreshRequirementStatuses } from "../store-helpers.js";
import { MarkdownFileWorkSource, resolveBriefPath } from "../file-work-source.js";
import type { CliContext, CliDependencies, DetachedRunOptions, RunOutcome } from "../types.js";

export async function runWorkItem(
  ctx: CliContext,
  workItemId: string,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  return runTrackedWorkItem(ctx, workItemId, options);
}

export async function runTrackedWorkItem(
  ctx: CliContext,
  workItemId: string,
  options: {
    verification?: string[];
    issueUrl?: string;
    requirePullRequest?: boolean;
    executionModeConfig?: { executionMode?: string; overlays?: string[]; risk?: string };
  } = {}
): Promise<RunOutcome> {
  const workItem = await mustGetWorkItem(ctx, workItemId);

  if (workItem.type !== "afk") {
    throw new Error(`Work item ${workItemId} is not AFK.`);
  }

  // Allow in_progress when this process was spawned as a detached worker by a --detach parent that
  // already set the work item status before spawning this background process.
  const isDetachedResume = !!process.env.AFK_DETACH_RUN_ID;
  const detachedOptions = isDetachedResume ? consumeDetachedRunOptionsFromEnv() : {};
  const isRunnable = workItem.status === "todo" || workItem.status === "failed" || (isDetachedResume && workItem.status === "in_progress");

  if (!isRunnable) {
    throw new Error(`Work item ${workItemId} is not runnable (current status: ${workItem.status}).`);
  }

  const requirement = await mustGetRequirement(ctx, workItem.requirementId);
  const verification = [...new Set([...ctx.config.verification, ...(options.verification ?? []), ...(detachedOptions.verification ?? [])])];
  const issueUrl = options.issueUrl ?? detachedOptions.issueUrl;
  const sourceUpdater = issueUrl ? ctx.sourceUpdaterFactory(issueUrl) : new NoOpSourceUpdater();
  const executionModeConfig = options.executionModeConfig ?? detachedOptions.executionModeConfig;
  let result: Awaited<ReturnType<CliContext["executionBackend"]["run"]>>;
  try {
    result = await ctx.executionBackend.run({
      requirement,
      workItem,
      verification,
      ...(issueUrl ? { issueUrl } : {}),
      ...(executionModeConfig ? { executionModeConfig } : {})
    });
  } catch (error) {
    const latestRun = await latestRunForWorkItem(ctx, workItem.id);
    if (!latestRun || latestRun.status === "running") {
      await markWorkItemRunFailed(ctx, workItem.id, `Worker execution failed: ${formatErrorMessage(error)}`);
    } else {
      await refreshRequirementStatuses(ctx);
    }
    await tryPostSourceUpdate(sourceUpdater, {
      status: "failed",
      summary: `Worker execution failed: ${formatErrorMessage(error)}`,
      issueComment: `**AFK run failed**\n\nWorker execution failed: ${formatErrorMessage(error)}`
    });
    throw error;
  }

  if (result.status === "blocked" || result.status === "failed") {
    const issueComment = result.issueComment.trim() || buildFallbackSourceComment({ status: result.status, summary: result.summary });
    await tryPostSourceUpdate(sourceUpdater, { status: result.status, summary: result.summary, issueComment });
    return {};
  }

  try {
    if (!result.hasDiff) {
      if (options.requirePullRequest) {
        await ctx.store.updateWorkItemStatus(workItem.id, "failed");
        const latestRun = await latestRunForWorkItem(ctx, workItem.id);
        if (latestRun) {
          await ctx.store.updateRun(latestRun.id, { status: "failed", summary: "Run completed without repo changes; no pull request could be opened" });
        }
        throw new Error(`Run completed without repo changes; no pull request could be opened for ${workItem.id}`);
      }

      const issueComment = result.issueComment.trim() || buildFallbackSourceComment({ status: "done", summary: result.summary });
      await tryPostSourceUpdate(sourceUpdater, { status: "done", summary: result.summary, issueComment });
      await refreshRequirementStatuses(ctx);
      return {};
    }

    if (ctx.resultPublisher && result.branchName && result.worktreePath) {
      const publication = await ctx.resultPublisher.publish({
        workItem,
        branchName: result.branchName,
        worktreePath: result.worktreePath,
        baseBranch: ctx.config.baseBranch,
        summary: result.summary,
        agentName: "Geoff",
        modelLabel: describeRunnerModel(ctx),
        ...(result.pullRequest ? { pullRequest: result.pullRequest } : {})
      });
      if (publication.externalRef) {
        await ctx.store.saveExternalRef(publication.externalRef);
      }
      const latestRun = await latestRunForWorkItem(ctx, workItem.id);
      await ctx.store.updateWorkItemStatus(workItem.id, "done");
      if (latestRun) {
        await ctx.store.updateRun(latestRun.id, { status: "completed", summary: result.summary });
      }
      await refreshRequirementStatuses(ctx);
      const prUrl = publication.url;
      const issueComment = result.issueComment.trim() || buildFallbackSourceComment({ status: "done", summary: result.summary, ...(prUrl ? { prUrl } : {}) });
      await tryPostSourceUpdate(sourceUpdater, { status: "done", summary: result.summary, issueComment, ...(prUrl ? { prUrl } : {}) });
      return {
        ...(prUrl ? { prUrl } : {})
      };
    }

    if (options.requirePullRequest) {
      await ctx.store.updateWorkItemStatus(workItem.id, "failed");
      const latestRun = await latestRunForWorkItem(ctx, workItem.id);
      if (latestRun) {
        await ctx.store.updateRun(latestRun.id, { status: "failed", summary: "Pull request was required but publishing was unavailable" });
      }
      throw new Error(`Pull request was required but GitHub publishing was unavailable for ${workItem.id}`);
    }

    const latestRun = await latestRunForWorkItem(ctx, workItem.id);
    await ctx.store.updateWorkItemStatus(workItem.id, "done");
    if (latestRun) {
      await ctx.store.updateRun(latestRun.id, { status: "completed", summary: result.summary });
    }
    await refreshRequirementStatuses(ctx);
    const issueCommentNoPr = result.issueComment.trim() || buildFallbackSourceComment({ status: "done", summary: result.summary });
    await tryPostSourceUpdate(sourceUpdater, { status: "done", summary: result.summary, issueComment: issueCommentNoPr });
    return {};
  } catch (error) {
    await markWorkItemRunFailed(ctx, workItem.id, `Post-run publication failed: ${formatErrorMessage(error)}`);
    throw error;
  }
}

export async function runExecutionBriefFile(
  ctx: CliContext,
  inputPath: string,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const briefPath = resolveBriefPath(ctx.cwd, inputPath);
  const brief = await new MarkdownFileWorkSource(ctx.cwd).load(inputPath);
  return await runImportedExecutionBrief(ctx, brief, {
    sourceLabel: `Imported from ${path.basename(briefPath)}`,
    sourceSummary: `Imported from ${briefPath}`,
    printedSource: briefPath,
    requirePullRequest: options.requirePullRequest ?? false
  });
}

export async function runGitHubIssue(
  ctx: CliContext,
  issueUrl: string,
  dependencies: CliDependencies,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const githubToken = ctx.githubToken ?? await resolveGitHubTokenLocal(dependencies);

  if (!githubToken) {
    throw new Error("GitHub issue execution requires GitHub auth (`GH_TOKEN` or `gh auth login`)");
  }

  const workSource = dependencies.githubIssueWorkSourceFactory
    ? dependencies.githubIssueWorkSourceFactory(githubToken)
    : new GitHubIssueWorkSource(githubToken);
  const brief = await workSource.load(issueUrl);

  return await runImportedExecutionBrief(ctx, brief, {
    sourceLabel: `Imported from ${issueUrl}`,
    sourceSummary: `Imported from ${issueUrl}`,
    printedSource: issueUrl,
    requirePullRequest: options.requirePullRequest ?? false
  });
}

/**
 * Create the requirement and work item from an execution brief, print the import summary, and
 * return the created work item. Does not start execution.
 */
export async function importExecutionBrief(
  ctx: CliContext,
  brief: {
    requirementBody: string;
    workItemTitle: string;
    workItemBody: string;
    acceptanceCriteria: string[];
    verification: string[];
    issueUrl?: string;
  },
  options: {
    sourceLabel: string;
    sourceSummary: string;
    printedSource: string;
  }
): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const requirement: Requirement = {
    id: createId("req"),
    title: deriveTitle(brief.requirementBody),
    body: brief.requirementBody,
    status: "captured",
    createdAt: now,
    updatedAt: now
  };

  await ctx.store.createRequirement(requirement);
  const [workItem] = await ctx.store.createDraftWorkItems(
    requirement.id,
    options.sourceLabel,
    [
      {
        planKey: slugify(brief.workItemTitle) || "imported-brief",
        title: brief.workItemTitle,
        body: brief.workItemBody,
        type: "afk",
        acceptanceCriteria: brief.acceptanceCriteria,
        executionSummary: options.sourceSummary,
        dependencyPlanKeys: []
      }
    ]
  );

  if (!workItem) {
    throw new Error(`Failed to create work item from ${options.printedSource}`);
  }

  await ctx.store.updateRequirementStatus(requirement.id, "planned");
  await ctx.store.updateWorkItemStatus(workItem.id, "todo");
  await ctx.store.updateRequirementStatus(requirement.id, "approved");

  console.log(`Imported execution brief ${options.printedSource}`);
  console.log(`Requirement ${requirement.id}`);
  console.log(`Work item ${workItem.id}`);

  return workItem;
}

async function runImportedExecutionBrief(
  ctx: CliContext,
  brief: {
    requirementBody: string;
    workItemTitle: string;
    workItemBody: string;
    acceptanceCriteria: string[];
    verification: string[];
    issueUrl?: string;
    executionMode?: string;
    overlays?: string[];
    risk?: string;
  },
  options: {
    sourceLabel: string;
    sourceSummary: string;
    printedSource: string;
    requirePullRequest?: boolean;
  }
): Promise<RunOutcome> {
  const workItem = await importExecutionBrief(ctx, brief, options);

  const hasExplicitMode = brief.executionMode || brief.overlays || brief.risk;
  const executionModeConfig = hasExplicitMode
    ? {
        ...(brief.executionMode ? { executionMode: brief.executionMode } : {}),
        ...(brief.overlays ? { overlays: brief.overlays } : {}),
        ...(brief.risk ? { risk: brief.risk } : {})
      }
    : undefined;

  const runOptions: {
    verification?: string[];
    issueUrl?: string;
    requirePullRequest?: boolean;
    executionModeConfig?: { executionMode?: string; overlays?: string[]; risk?: string };
  } = {
    verification: brief.verification
  };

  if (options.requirePullRequest) {
    runOptions.requirePullRequest = true;
  }

  if (brief.issueUrl) {
    runOptions.issueUrl = brief.issueUrl;
  }

  if (executionModeConfig) {
    runOptions.executionModeConfig = executionModeConfig;
  }

  return await runTrackedWorkItem(ctx, workItem.id, runOptions);
}

// ---------------------------------------------------------------------------
// Detached execution helpers
// ---------------------------------------------------------------------------

/**
 * Start a work item run in the background.
 *
 * The parent process pre-creates the run record and marks the work item as
 * in_progress so that `afk status` / `afk runs` show the run immediately.
 * A background subprocess is spawned (via `detachLauncher`) to do the actual
 * Docker execution; it picks up the pre-created run ID through AFK_DETACH_RUN_ID.
 */
export async function runWorkItemDetached(
  ctx: CliContext,
  workItemId: string,
  dependencies: CliDependencies,
  options: DetachedRunOptions & { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const workItem = await mustGetWorkItem(ctx, workItemId);

  if (workItem.type !== "afk") {
    throw new Error(`Work item ${workItemId} is not AFK.`);
  }

  if (workItem.status !== "todo" && workItem.status !== "failed") {
    throw new Error(`Work item ${workItemId} is not runnable (current status: ${workItem.status}).`);
  }

  const runId = createId("run");
  const branchName = branchNameForWorkItem(workItem.title);
  const worktreePath = path.join(ctx.paths.worktreesDir, runId);
  const runDir = path.join(ctx.paths.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });

  await ctx.store.createRun({
    id: runId,
    workItemId: workItem.id,
    mode: "work",
    status: "running",
    branchName,
    worktreePath,
    runDir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await ctx.store.updateWorkItemStatus(workItem.id, "in_progress");

  fs.writeFileSync(
    path.join(runDir, "progress.json"),
    JSON.stringify(
      { phase: "starting", message: "Detached worker starting", iteration: 0, updatedAt: new Date().toISOString() },
      null,
      2
    )
  );

  const launchEnv: NodeJS.ProcessEnv = { ...process.env, AFK_DETACH_RUN_ID: runId };
  const detachedOptions = JSON.stringify({
    verification: options.verification ?? [],
    ...(options.issueUrl ? { issueUrl: options.issueUrl } : {}),
    ...(options.executionModeConfig ? { executionModeConfig: options.executionModeConfig } : {})
  });
  launchEnv.AFK_DETACH_RUN_OPTIONS = detachedOptions;
  const launchArgv: string[] = [
    process.execPath,
    process.argv[1] ?? "afk",
    "run",
    workItemId,
    ...(options.requirePullRequest ? ["--pr"] : [])
  ];

  const launcher = dependencies.detachLauncher ?? spawnDetachedProcess;
  let pid = 0;
  try {
    ({ pid } = launcher(launchArgv, launchEnv, ctx.repoRoot));
  } catch (error) {
    const message = `Detached launch failed: ${formatErrorMessage(error)}`;
    await ctx.store.updateRun(runId, { status: "failed", summary: message });
    await ctx.store.updateWorkItemStatus(workItem.id, "failed");
    await refreshRequirementStatuses(ctx);
    throw new Error(message);
  }

  if (pid > 0) {
    fs.writeFileSync(
      path.join(runDir, "detach-process.json"),
      JSON.stringify({ pid, startedAt: new Date().toISOString() }, null, 2)
    );
  }

  console.log(`Run ${runId}`);
  console.log(`  pnpm afk status`);
  console.log(`  pnpm afk runs`);

  return {};
}

export async function runExecutionBriefFileDetached(
  ctx: CliContext,
  inputPath: string,
  dependencies: CliDependencies,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const briefPath = resolveBriefPath(ctx.cwd, inputPath);
  const brief = await new MarkdownFileWorkSource(ctx.cwd).load(inputPath);
  const workItem = await importExecutionBrief(ctx, brief, {
    sourceLabel: `Imported from ${path.basename(briefPath)}`,
    sourceSummary: `Imported from ${briefPath}`,
    printedSource: briefPath
  });
  const briefModeConfig =
    brief.executionMode || brief.overlays || brief.risk
      ? {
          ...(brief.executionMode ? { executionMode: brief.executionMode } : {}),
          ...(brief.overlays ? { overlays: brief.overlays } : {}),
          ...(brief.risk ? { risk: brief.risk } : {})
        }
      : undefined;
  return runWorkItemDetached(ctx, workItem.id, dependencies, {
    ...options,
    verification: brief.verification,
    ...(brief.issueUrl ? { issueUrl: brief.issueUrl } : {}),
    ...(briefModeConfig ? { executionModeConfig: briefModeConfig } : {})
  });
}

export async function runGitHubIssueDetached(
  ctx: CliContext,
  issueUrl: string,
  dependencies: CliDependencies,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const githubToken = ctx.githubToken ?? await resolveGitHubTokenLocal(dependencies);

  if (!githubToken) {
    throw new Error("GitHub issue execution requires GitHub auth (`GH_TOKEN` or `gh auth login`)");
  }

  const workSource = dependencies.githubIssueWorkSourceFactory
    ? dependencies.githubIssueWorkSourceFactory(githubToken)
    : new GitHubIssueWorkSource(githubToken);
  const brief = await workSource.load(issueUrl);
  const workItem = await importExecutionBrief(ctx, brief, {
    sourceLabel: `Imported from ${issueUrl}`,
    sourceSummary: `Imported from ${issueUrl}`,
    printedSource: issueUrl
  });
  const issueModeConfig =
    brief.executionMode || brief.overlays || brief.risk
      ? {
          ...(brief.executionMode ? { executionMode: brief.executionMode } : {}),
          ...(brief.overlays ? { overlays: brief.overlays } : {}),
          ...(brief.risk ? { risk: brief.risk } : {})
        }
      : undefined;
  return runWorkItemDetached(ctx, workItem.id, dependencies, {
    ...options,
    verification: brief.verification,
    ...(brief.issueUrl ? { issueUrl: brief.issueUrl } : {}),
    ...(issueModeConfig ? { executionModeConfig: issueModeConfig } : {})
  });
}

// ---------------------------------------------------------------------------

function consumeDetachedRunOptionsFromEnv(): DetachedRunOptions {
  const source = process.env.AFK_DETACH_RUN_OPTIONS;
  delete process.env.AFK_DETACH_RUN_OPTIONS;

  if (!source) {
    return {};
  }

  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const maybeVerification = (parsed as { verification?: unknown }).verification;
    const maybeIssueUrl = (parsed as { issueUrl?: unknown }).issueUrl;
    const maybeModeConfig = (parsed as { executionModeConfig?: unknown }).executionModeConfig;

    const verification = Array.isArray(maybeVerification)
      ? maybeVerification.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    const issueUrl = typeof maybeIssueUrl === "string" && maybeIssueUrl.trim().length > 0 ? maybeIssueUrl : undefined;
    const executionModeConfig =
      maybeModeConfig && typeof maybeModeConfig === "object"
        ? (maybeModeConfig as { executionMode?: string; overlays?: string[]; risk?: string })
        : undefined;

    return {
      verification,
      ...(issueUrl ? { issueUrl } : {}),
      ...(executionModeConfig ? { executionModeConfig } : {})
    };
  } catch {
    return {};
  }
}

function spawnDetachedProcess(argv: string[], env: NodeJS.ProcessEnv, cwd: string): { pid: number } {
  const [cmd, ...args] = argv;

  if (!cmd) {
    return { pid: 0 };
  }

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env,
    cwd
  });
  child.unref();
  return { pid: child.pid ?? 0 };
}

async function resolveGitHubTokenLocal(dependencies: CliDependencies): Promise<string | undefined> {
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }
  if (dependencies.githubTokenResolver) {
    return await dependencies.githubTokenResolver();
  }
  return undefined;
}
