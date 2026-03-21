import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { GitHubIssueWorkSource, GitHubMirror, GitHubPullRequestPublisher } from "@afk-geoff/adapter-github";
import { LocalGitCodeHost, branchNameForWorkItem } from "@afk-geoff/adapter-local-git";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import { classifyWorkItems, createReviewBrief, evaluateNextStatus, summarizeRequirementStatus, type AgentRunner, type ChangeRequestPublisher, type ExecutionBackend, type ExternalRef, type HydratedWorkItem, type IssueMirror, type Requirement, type ResultPublisher, type RunProgress, type WorkItem, type WorkSource } from "@afk-geoff/core";
import { ClaudeCliRunner } from "@afk-geoff/runner-claude";
import { CodexCliRunner } from "@afk-geoff/runner-codex";
import { DockerWorkspaceRuntime } from "@afk-geoff/runtime-docker";
import {
  buildReviewBrief as buildRichReviewBrief,
  configFilePath,
  createId,
  defaultProjectConfig,
  deriveTitle,
  ensureProjectLayout,
  loadProjectConfig,
  maybeReadOverride,
  resolveProjectPaths,
  slugify,
  writeDefaultProjectFiles,
} from "@afk-geoff/shared";
import { MarkdownFileWorkSource, resolveBriefPath } from "./file-work-source.js";
import { LocalDockerExecutionBackend } from "./local-docker-execution-backend.js";

const execFileAsync = promisify(execFile);

interface CliContext {
  cwd: string;
  repoRoot: string;
  config: ReturnType<typeof loadProjectConfig>;
  paths: ReturnType<typeof resolveProjectPaths>;
  store: SqliteStateStore;
  git: LocalGitCodeHost;
  runtime: DockerWorkspaceRuntime;
  runner: AgentRunner;
  githubToken: string | undefined;
  github: (IssueMirror & ChangeRequestPublisher) | undefined;
  executionBackend: ExecutionBackend;
  resultPublisher: ResultPublisher | undefined;
  remote: { owner: string; repo: string } | undefined;
}

interface CliDependencies {
  githubFactory?: (token: string) => IssueMirror & ChangeRequestPublisher;
  githubIssueWorkSourceFactory?: (token: string) => WorkSource<string>;
  githubTokenResolver?: () => Promise<string | undefined>;
}

interface RunOutcome {
  prUrl?: string;
}

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

  program
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
    .action(async (target: string, value: string | undefined, options: { pr?: boolean }) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await autoSync(ctx);

      if (options.pr) {
        assertPullRequestReady(ctx);
      }

      let outcome: RunOutcome;

      if (target === "file") {
        if (!value) {
          throw new Error("Usage: pnpm afk run file <path>");
        }

        outcome = await runExecutionBriefFile(ctx, value, { requirePullRequest: options.pr ?? false });
      } else if (target === "issue") {
        if (!value) {
          throw new Error("Usage: pnpm afk run issue <github-issue-url>");
        }

        outcome = await runGitHubIssue(ctx, value, dependencies, { requirePullRequest: options.pr ?? false });
      } else {
        outcome = await runWorkItem(ctx, target, { requirePullRequest: options.pr ?? false });
      }

      if (outcome.prUrl) {
        console.log(`Opened PR: ${outcome.prUrl}`);
      }
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

  program.command("sync").action(async () => {
    const ctx = await openContext(process.cwd(), dependencies);
    await autoSync(ctx);
    console.log("Sync complete");
  });

  await program.parseAsync(argv);
}

async function openContext(cwd: string, dependencies: CliDependencies): Promise<CliContext> {
  const git = new LocalGitCodeHost();
  const repoRoot = await git.assertRepository(cwd);
  const config = loadProjectConfig(repoRoot);
  const paths = ensureProjectLayout(repoRoot, config);
  const store = new SqliteStateStore(paths.statePath);
  const runtime = new DockerWorkspaceRuntime();
  const runner = createRunner(config.runner.kind);
  const remote = config.github.enabled ? config.github.owner && config.github.repo ? { owner: config.github.owner, repo: config.github.repo } : await git.getRemoteSlug(repoRoot) : undefined;
  const githubToken = await resolveGitHubToken(dependencies);
  const github = config.github.enabled && githubToken
    ? dependencies.githubFactory
      ? dependencies.githubFactory(githubToken)
      : new GitHubMirror(githubToken)
    : undefined;
  const executionBackend = new LocalDockerExecutionBackend({
    repoRoot,
    config,
    paths,
    store,
    git,
    runtime,
    runner,
    ...(githubToken ? { githubToken } : {})
  });
  const resultPublisher = github && remote
    ? new GitHubPullRequestPublisher(git, github, remote)
    : undefined;

  return {
    cwd,
    repoRoot,
    config,
    paths,
    store,
    git,
    runtime,
    runner,
    githubToken,
    github,
    executionBackend,
    resultPublisher,
    remote
  };
}

function createRunner(kind: "claude" | "codex"): AgentRunner {
  return kind === "claude" ? new ClaudeCliRunner() : new CodexCliRunner();
}

function describeRunnerModel(ctx: CliContext): string {
  if (ctx.runner.kind === "claude") {
    return "Claude CLI default (no explicit model configured)";
  }

  return "Codex CLI default (no explicit model configured)";
}

function withCommandOverride(commandOverride: string[] | undefined): { commandOverride: string[] } | Record<string, never> {
  return commandOverride ? { commandOverride } : {};
}

function withRequiredEnv(requiredEnv: string[] | undefined): { requiredEnv: string[] } | Record<string, never> {
  return requiredEnv ? { requiredEnv } : {};
}

function withReviewCommand(reviewCommandOverride: string[] | undefined): { reviewCommandOverride: string[] } | Record<string, never> {
  return reviewCommandOverride ? { reviewCommandOverride } : {};
}

function withText<K extends string>(key: K, value: string | undefined): { [P in K]: string } | Record<string, never> {
  return value ? { [key]: value } as { [P in K]: string } : {};
}

async function runDoctor(ctx: CliContext): Promise<void> {
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

async function captureRequirement(ctx: CliContext, prompt: string): Promise<Requirement> {
  const now = new Date().toISOString();
  const requirement: Requirement = {
    id: createId("req"),
    title: deriveTitle(prompt),
    body: prompt,
    status: "captured",
    createdAt: now,
    updatedAt: now
  };
  await ctx.store.createRequirement(requirement);

  if (ctx.config.github.enabled) {
    await mirrorRequirement(ctx, requirement);
  }

  return requirement;
}

async function printStatus(ctx: CliContext): Promise<void> {
  const requirements = await ctx.store.listRequirements();
  const workItems = await ctx.store.listWorkItems();
  const runs = await ctx.store.listRuns();
  const prRefs = await ctx.store.listExternalRefs("work_item", "pull_request");
  const decisions = classifyWorkItems(workItems);

  console.log("Requirements");
  printLinesOrNone(requirements.map((requirement) => `- ${requirement.id}  ${requirement.title}  ${requirement.status}`));
  console.log("");
  console.log("Runnable AFK items");
  printLinesOrNone(decisions.runnable.map((item) => `- ${item.id}  ${item.title}`));
  console.log("");
  console.log("Blocked items");
  printLinesOrNone(decisions.blocked.map((item) => `- ${item.id}  ${item.title}`));
  console.log("");
  console.log("HITL items");
  printLinesOrNone(decisions.hitl.map((item) => `- ${item.id}  ${item.title}`));
  console.log("");
  console.log("Active runs / open PRs");
  const activeLines: string[] = [];
  for (const run of runs.filter((record) => record.status === "running" || record.status === "prepared")) {
    const progress = readRunProgress(run.runDir);
    if (progress) {
      activeLines.push(`- ${run.id}  ${run.workItemId}  ${run.status}  [${progress.phase}] ${progress.message} (iteration ${progress.iteration}, updated ${progress.updatedAt})`);
    } else {
      activeLines.push(`- ${run.id}  ${run.workItemId}  ${run.status}`);
    }
  }
  for (const ref of prRefs) {
    const syncState = await ctx.store.getSyncState(ref.id) as { state?: "open" | "closed"; merged?: boolean } | undefined;
    if (syncState?.state === "closed" || syncState?.merged) {
      continue;
    }
    const workItem = workItems.find((item) => item.id === ref.entityId);
    if (workItem?.status !== "done") {
      activeLines.push(`- PR #${ref.remoteNumber}  ${workItem?.title ?? ref.entityId}`);
    }
  }
  printLinesOrNone(activeLines);
  console.log("");
  printNextActionLines(getGlobalNextActions(requirements, workItems));
}

async function showEntity(ctx: CliContext, entityId: string): Promise<void> {
  const requirement = await ctx.store.getRequirement(entityId);

  if (requirement) {
    const items = await ctx.store.listWorkItemsByRequirement(requirement.id);
    const issueRef = await ctx.store.getExternalRefForEntity("requirement", requirement.id, "issue");
    console.log(`Requirement ${requirement.id}`);
    console.log(`Title: ${requirement.title}`);
    console.log(`Status: ${requirement.status}`);
    console.log("");
    console.log(requirement.body);
    console.log("");
    console.log("Work items");
    for (const item of items) {
      console.log(`- ${item.id}  ${item.planKey}  ${item.status}  ${item.title}`);
    }
    if (issueRef?.url) {
      console.log("");
      console.log(`Mirrored issue: ${issueRef.url}`);
    }
    console.log("");
    printNextActionLines(getRequirementNextActions(items));
    return;
  }

  const workItem = await ctx.store.getWorkItem(entityId);

  if (!workItem) {
    throw new Error(`Entity ${entityId} not found`);
  }

  const requirementForItem = await mustGetRequirement(ctx, workItem.requirementId);
  const dependencyTitles = await Promise.all(
    workItem.dependencyIds.map(async (dependencyId) => (await ctx.store.getWorkItem(dependencyId))?.title ?? dependencyId)
  );
  const issueRef = await ctx.store.getExternalRefForEntity("work_item", workItem.id, "issue");
  const prRef = await ctx.store.getExternalRefForEntity("work_item", workItem.id, "pull_request");
  console.log(`Work item ${workItem.id}`);
  console.log(`Title: ${workItem.title}`);
  console.log(`Requirement: ${requirementForItem.id}  ${requirementForItem.title}`);
  console.log(`Type: ${workItem.type}`);
  console.log(`Status: ${workItem.status}`);
  console.log(`Plan key: ${workItem.planKey}`);
  console.log("");
  console.log(workItem.body);
  console.log("");
  console.log("Acceptance criteria");
  for (const criterion of workItem.acceptanceCriteria) {
    console.log(`- ${criterion}`);
  }
  console.log("");
  console.log("Dependencies");
  for (const title of dependencyTitles.length > 0 ? dependencyTitles : ["None"]) {
    console.log(`- ${title}`);
  }
  console.log("");
  console.log(`Execution summary: ${workItem.executionSummary}`);
  if (issueRef?.url) {
    console.log(`Mirrored issue: ${issueRef.url}`);
  }
  if (prRef?.url) {
    console.log(`Mirrored pull request: ${prRef.url}`);
  }

  const runs = await ctx.store.listRuns();
  const activeRun = runs
    .filter((run) => run.workItemId === workItem.id && (run.status === "running" || run.status === "prepared"))
    .at(-1);
  if (activeRun) {
    const progress = readRunProgress(activeRun.runDir);
    if (progress) {
      console.log(`Active run: ${activeRun.id}`);
      console.log(`Progress: [${progress.phase}] ${progress.message} (iteration ${progress.iteration}, updated ${progress.updatedAt})`);
    }
  }

  console.log("");
  printNextActionLines(getWorkItemNextActions(workItem));
}

async function printRuns(ctx: CliContext): Promise<void> {
  const runs = await ctx.store.listRuns();
  console.log("Runs");
  for (const run of runs) {
    console.log(`- ${run.id}  ${run.mode}  ${run.status}  ${run.workItemId}`);
    console.log(`  run dir: ${run.runDir}`);
    if (run.worktreePath) {
      console.log(`  worktree: ${run.worktreePath}`);
    }
    if (run.summary) {
      console.log(`  summary: ${run.summary}`);
    }
  }
}

async function printRunLogs(ctx: CliContext, runId: string): Promise<void> {
  const run = (await ctx.store.listRuns()).find((record) => record.id === runId);

  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }

  const logFiles = [
    { label: "manifest", path: path.join(run.runDir, "manifest.json") },
    { label: "prompt", path: path.join(run.runDir, "prompt.md") },
    { label: "stdout", path: path.join(run.runDir, "stdout.log") },
    { label: "stderr", path: path.join(run.runDir, "stderr.log") },
    { label: "result", path: path.join(run.runDir, "result.json") },
    { label: "review", path: path.join(run.runDir, "review.md") }
  ];

  console.log(`Run ${run.id}`);
  console.log(`Mode: ${run.mode}`);
  console.log(`Status: ${run.status}`);
  console.log(`Run dir: ${run.runDir}`);
  if (run.worktreePath) {
    console.log(`Worktree: ${run.worktreePath}`);
  }

  for (const file of logFiles) {
    if (!fs.existsSync(file.path)) {
      continue;
    }

    console.log("");
    console.log(`== ${file.label}: ${file.path} ==`);
    console.log(fs.readFileSync(file.path, "utf8"));
  }
}

async function runWorkItem(
  ctx: CliContext,
  workItemId: string,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  return runTrackedWorkItem(ctx, workItemId, options);
}

async function runTrackedWorkItem(
  ctx: CliContext,
  workItemId: string,
  options: { verification?: string[]; issueUrl?: string; requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const workItem = await mustGetWorkItem(ctx, workItemId);

  if (workItem.type !== "afk") {
    throw new Error(`Work item ${workItemId} is not AFK.`);
  }

  if (workItem.status !== "todo" && workItem.status !== "failed") {
    throw new Error(`Work item ${workItemId} is not runnable (current status: ${workItem.status}).`);
  }

  const requirement = await mustGetRequirement(ctx, workItem.requirementId);
  const verification = [...new Set([...ctx.config.verification, ...(options.verification ?? [])])];
  const result = await ctx.executionBackend.run({
    requirement,
    workItem,
    verification,
    ...(options.issueUrl ? { issueUrl: options.issueUrl } : {})
  });

  const issueRef = await ctx.store.getExternalRefForEntity("work_item", workItem.id, "issue");

  if (ctx.github && ctx.remote && issueRef && result.issueComment.trim()) {
    await ctx.github.commentOnIssue({
      owner: ctx.remote.owner,
      repo: ctx.remote.repo,
      issueNumber: issueRef.remoteNumber,
      body: result.issueComment
    });
  }

  if (result.status === "blocked" || result.status === "failed") {
    return {};
  }

  if (!result.hasDiff) {
    if (options.requirePullRequest) {
      await ctx.store.updateWorkItemStatus(workItem.id, "failed");
      const latestRun = await latestRunForWorkItem(ctx, workItem.id);
      if (latestRun) {
        await ctx.store.updateRun(latestRun.id, { status: "failed", summary: "Run completed without repo changes; no pull request could be opened" });
      }
      throw new Error(`Run completed without repo changes; no pull request could be opened for ${workItem.id}`);
    }

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
    return {
      ...(publication.url ? { prUrl: publication.url } : {})
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
  return {};
}

async function runExecutionBriefFile(
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

async function runGitHubIssue(
  ctx: CliContext,
  issueUrl: string,
  dependencies: CliDependencies,
  options: { requirePullRequest?: boolean } = {}
): Promise<RunOutcome> {
  const githubToken = ctx.githubToken ?? await resolveGitHubToken(dependencies);

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

async function runImportedExecutionBrief(
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
    requirePullRequest?: boolean;
  }
): Promise<RunOutcome> {
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

  const runOptions: { verification?: string[]; issueUrl?: string; requirePullRequest?: boolean } = {
    verification: brief.verification
  };

  if (options.requirePullRequest) {
    runOptions.requirePullRequest = true;
  }

  if (brief.issueUrl) {
    runOptions.issueUrl = brief.issueUrl;
  }

  return await runTrackedWorkItem(ctx, workItem.id, runOptions);
}

async function dispatchLoop(ctx: CliContext, maxIterations: number): Promise<void> {
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`--max must be a positive integer, received: ${maxIterations}`);
  }

  let iterations = 0;

  while (iterations < maxIterations) {
    await autoSync(ctx);
    const nextItem = (await ctx.store.listWorkItems()).find((item) => item.type === "afk" && item.status === "todo");

    if (!nextItem) {
      const reason = iterations === 0 ? "no runnable AFK items" : "queue drained";
      console.log(`Dispatch complete after ${iterations} iteration(s): ${reason}`);
      return;
    }

    iterations += 1;
    console.log(`Dispatch iteration ${iterations}/${maxIterations}: ${nextItem.id}  ${nextItem.title}`);
    await runTrackedWorkItem(ctx, nextItem.id);
  }

  console.log(`Dispatch complete after ${iterations} iteration(s): reached loop limit`);
}

async function prepareReview(ctx: CliContext, workItemId: string): Promise<void> {
  const workItem = await mustGetWorkItem(ctx, workItemId);

  if (workItem.status !== "hitl_pending") {
    throw new Error(`Work item ${workItemId} is not HITL pending.`);
  }

  const requirement = await mustGetRequirement(ctx, workItem.requirementId);
  const runId = createId("run");
  const branchName = branchNameForWorkItem(`review-${workItem.title}`);
  const worktreePath = path.join(ctx.paths.worktreesDir, runId);
  const runDir = path.join(ctx.paths.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  await ctx.git.createWorktree({
    cwd: ctx.repoRoot,
    branchName,
    baseBranch: ctx.config.baseBranch,
    path: worktreePath
  });

  const allItems = await ctx.store.listWorkItemsByRequirement(requirement.id);
  const dependencyTitles = workItem.dependencyIds
    .map((dependencyId) => allItems.find((item) => item.id === dependencyId)?.title)
    .filter((title): title is string => Boolean(title));
  const reviewPath = path.join(runDir, "review.md");
  const reviewBrief = buildRichReviewBrief({
    requirement,
    workItem,
    dependencyTitles,
    ...withText("overrideText", maybeReadOverride(ctx.repoRoot, ctx.config.prompts?.review))
  });
  fs.writeFileSync(reviewPath, reviewBrief);

  await ctx.store.createRun({
    id: runId,
    workItemId: workItem.id,
    mode: "review",
    status: "prepared",
    branchName,
    worktreePath,
    runDir,
    summary: createReviewBrief(requirement, workItem, dependencyTitles),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const relativeBriefPath = path.relative(worktreePath, reviewPath) || reviewPath;
  const command = ctx.runner.buildReviewCommand({
    briefPath: relativeBriefPath,
    ...withReviewCommand(ctx.config.runner.reviewCommand),
    ...withCommandOverride(ctx.config.runner.command)
  });
  console.log(`cd ${worktreePath}`);
  console.log(command.join(" "));
}

async function autoSync(ctx: CliContext): Promise<void> {
  if (ctx.github && ctx.remote) {
    const issueRefs = await ctx.store.listExternalRefs(undefined, "issue");
    const pullRefs = await ctx.store.listExternalRefs("work_item", "pull_request");
    const issueSync = await ctx.github.syncIssues({
      owner: ctx.remote.owner,
      repo: ctx.remote.repo,
      refs: issueRefs
    });

    for (const record of issueSync) {
      await ctx.store.saveSyncState({
        externalRefId: record.refId,
        payload: record
      });
    }

    const prSync = await ctx.github.syncPullRequests({
      owner: ctx.remote.owner,
      repo: ctx.remote.repo,
      refs: pullRefs
    });

    for (const record of prSync) {
      await ctx.store.saveSyncState({
        externalRefId: record.refId,
        payload: record
      });
      const ref = pullRefs.find((item) => item.id === record.refId);

      if (!ref) {
        continue;
      }

      if (record.merged) {
        await ctx.store.updateWorkItemStatus(ref.entityId, "done");
      } else if (record.state === "closed") {
        const workItem = await ctx.store.getWorkItem(ref.entityId);
        if (workItem && workItem.status === "in_progress") {
          await ctx.store.updateWorkItemStatus(ref.entityId, "failed");
        }
      }
    }
  }

  await reconcileLocalRuns(ctx);

  const items = await ctx.store.listWorkItems();
  const itemMap = new Map(items.map((item) => [item.id, item]));

  for (const item of items) {
    const nextStatus = evaluateNextStatus(item, itemMap);

    if (nextStatus !== item.status) {
      await ctx.store.updateWorkItemStatus(item.id, nextStatus);
    }
  }

  await refreshRequirementStatuses(ctx);
  await mirrorActionableWorkItems(ctx);
}

async function reconcileLocalRuns(ctx: CliContext): Promise<void> {
  const runs = await ctx.store.listRuns();

  for (const run of runs) {
    if (run.status !== "running") {
      continue;
    }

    if (fs.existsSync(run.runDir)) {
      continue;
    }

    await ctx.store.updateRun(run.id, {
      status: "failed",
      summary: "Run directory missing; treating interrupted run as failed"
    });

    const workItem = await ctx.store.getWorkItem(run.workItemId);
    if (workItem?.status === "in_progress") {
      await ctx.store.updateWorkItemStatus(run.workItemId, "failed");
    }
  }
}

async function refreshRequirementStatuses(ctx: CliContext): Promise<void> {
  const requirements = await ctx.store.listRequirements();

  for (const requirement of requirements) {
    const items = await ctx.store.listWorkItemsByRequirement(requirement.id);
    const nextStatus = summarizeRequirementStatus(items);

    if (nextStatus !== requirement.status) {
      await ctx.store.updateRequirementStatus(requirement.id, nextStatus);
    }
  }
}

async function mirrorRequirement(ctx: CliContext, requirement: Requirement): Promise<void> {
  if (!ctx.github || !ctx.remote) {
    return;
  }

  const existing = await ctx.store.getExternalRefForEntity("requirement", requirement.id, "issue");

  if (existing) {
    return;
  }

  const ref = await ctx.github.mirrorRequirement({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    requirement
  });
  await ctx.store.saveExternalRef(ref);
}

async function mirrorActionableWorkItems(ctx: CliContext): Promise<void> {
  if (!ctx.github || !ctx.remote) {
    return;
  }

  const requirements = new Map((await ctx.store.listRequirements()).map((requirement) => [requirement.id, requirement]));
  const items = await ctx.store.listWorkItems();

  for (const item of items) {
    if (item.status !== "todo" && item.status !== "hitl_pending") {
      continue;
    }

    const existing = await ctx.store.getExternalRefForEntity("work_item", item.id, "issue");

    if (existing) {
      continue;
    }

    const requirement = requirements.get(item.requirementId);

    if (!requirement) {
      continue;
    }

    const ref = await ctx.github.mirrorWorkItem({
      owner: ctx.remote.owner,
      repo: ctx.remote.repo,
      workItem: item,
      requirement
    });
    await ctx.store.saveExternalRef(ref);
  }
}

async function mustGetRequirement(ctx: CliContext, requirementId: string): Promise<Requirement> {
  const requirement = await ctx.store.getRequirement(requirementId);

  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`);
  }

  return requirement;
}

async function mustGetWorkItem(ctx: CliContext, workItemId: string): Promise<HydratedWorkItem> {
  const item = await ctx.store.getWorkItem(workItemId);

  if (!item) {
    throw new Error(`Work item ${workItemId} not found`);
  }

  return item;
}

async function latestRunForWorkItem(ctx: CliContext, workItemId: string) {
  const runs = await ctx.store.listRuns();
  return runs
    .filter((run) => run.workItemId === workItemId && run.mode === "work")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

async function undoWorkItem(
  ctx: CliContext,
  workItemId: string,
  options: { deleteBranch: boolean }
): Promise<void> {
  if (!ctx.github || !ctx.remote) {
    throw new Error("Undo requires GitHub publishing to be enabled and authenticated");
  }

  const workItem = await mustGetWorkItem(ctx, workItemId);
  const prRef = await ctx.store.getExternalRefForEntity("work_item", workItem.id, "pull_request");

  if (!prRef) {
    throw new Error(`Work item ${workItem.id} does not have an AFK-created pull request to undo`);
  }

  const [pullState] = await ctx.github.syncPullRequests({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    refs: [prRef]
  });

  if (!pullState) {
    throw new Error(`Could not determine pull request state for ${workItem.id}`);
  }

  await ctx.store.saveSyncState({
    externalRefId: prRef.id,
    payload: pullState
  });

  if (pullState.merged) {
    throw new Error(`Pull request #${prRef.remoteNumber} is already merged; AFK undo only supports open, unmerged PRs`);
  }

  if (pullState.state === "closed") {
    throw new Error(`Pull request #${prRef.remoteNumber} is already closed`);
  }

  await ctx.github.closePullRequest({
    owner: ctx.remote.owner,
    repo: ctx.remote.repo,
    pullNumber: prRef.remoteNumber
  });
  await ctx.store.saveSyncState({
    externalRefId: prRef.id,
    payload: {
      refId: prRef.id,
      state: "closed",
      merged: false
    }
  });

  const latestRun = await latestRunForWorkItem(ctx, workItem.id);
  const branchName = latestRun?.branchName;
  const worktreePath = latestRun?.worktreePath;
  const summary = options.deleteBranch && branchName
    ? `Undone by operator: closed PR #${prRef.remoteNumber} and deleted branch ${branchName}`
    : `Undone by operator: closed PR #${prRef.remoteNumber}`;

  if (options.deleteBranch && worktreePath && fs.existsSync(worktreePath)) {
    await ctx.git.removeWorktree({
      cwd: ctx.repoRoot,
      path: worktreePath,
      force: true
    });
  }

  if (options.deleteBranch && branchName) {
    try {
      await ctx.git.deleteRemoteBranch({
        cwd: ctx.repoRoot,
        branchName
      });
    } catch {
      // Remote branch may already be gone; closing the PR is still the important part.
    }

    try {
      await ctx.git.deleteLocalBranch({
        cwd: ctx.repoRoot,
        branchName
      });
    } catch {
      // Local branch may already be gone or attached elsewhere; keep undo best-effort.
    }
  }

  await ctx.store.updateWorkItemStatus(workItem.id, "failed");
  await ctx.store.updateWorkItemSummary(workItem.id, summary);

  if (latestRun) {
    await ctx.store.updateRun(latestRun.id, {
      status: "failed",
      summary
    });
  }

  await refreshRequirementStatuses(ctx);

  console.log(`Closed PR #${prRef.remoteNumber} for ${workItem.id}`);
  if (options.deleteBranch && branchName) {
    console.log(`Deleted AFK branch ${branchName}`);
  }
}

async function resolveGitHubToken(dependencies: CliDependencies): Promise<string | undefined> {
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }

  if (dependencies.githubTokenResolver) {
    return await dependencies.githubTokenResolver();
  }

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

async function commandExistsError(command: string, label: string): Promise<string | undefined> {
  try {
    await execFileAsync("which", [command]);
    return undefined;
  } catch {
    return `Missing ${label} executable: ${command}`;
  }
}

function allowedEnv(envNames: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const name of envNames) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }

  return env;
}

function assertPullRequestReady(ctx: CliContext): void {
  if (!ctx.config.github.enabled) {
    throw new Error("Pull request publishing requires github.enabled: true");
  }

  if (!ctx.remote) {
    throw new Error("Pull request publishing requires an origin GitHub remote");
  }

  if (!ctx.github) {
    throw new Error("Pull request publishing requires GitHub auth (`GH_TOKEN` or `gh auth login`)");
  }
}

function printLinesOrNone(lines: string[]): void {
  for (const line of lines.length > 0 ? lines : ["- None"]) {
    console.log(line);
  }
}

function printNextActionLines(lines: string[]): void {
  console.log("Next");
  printLinesOrNone(lines);
}

function getGlobalNextActions(requirements: Requirement[], items: HydratedWorkItem[]): string[] {
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

function getRequirementNextActions(items: HydratedWorkItem[]): string[] {
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

function getWorkItemNextActions(item: HydratedWorkItem): string[] {
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

function readRunProgress(runDir: string): RunProgress | undefined {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
