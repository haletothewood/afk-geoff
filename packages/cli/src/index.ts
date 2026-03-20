import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { GitHubMirror } from "@afk-geoff/adapter-github";
import { LocalGitCodeHost, branchNameForWorkItem } from "@afk-geoff/adapter-local-git";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import { classifyWorkItems, createReviewBrief, evaluateNextStatus, summarizeRequirementStatus, type AgentRunner, type ChangeRequest, type ChangeRequestPublisher, type ExternalRef, type HydratedWorkItem, type IssueMirror, type Requirement, type WorkItem, type WorkItemStatus } from "@afk-geoff/core";
import { ClaudeCliRunner } from "@afk-geoff/runner-claude";
import { CodexCliRunner } from "@afk-geoff/runner-codex";
import { DockerWorkspaceRuntime } from "@afk-geoff/runtime-docker";
import {
  buildPlanPrompt,
  buildReviewBrief as buildRichReviewBrief,
  buildWorkerPrompt,
  configFilePath,
  createId,
  defaultProjectConfig,
  deriveTitle,
  ensureProjectLayout,
  loadProjectConfig,
  maybeReadOverride,
  plannerOutputSchema,
  resolveProjectPaths,
  runProcess,
  slugify,
  workerResultSchema,
  writeDefaultProjectFiles,
  DEFAULT_DOCKERFILE_PATH
} from "@afk-geoff/shared";

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
  github: (IssueMirror & ChangeRequestPublisher) | undefined;
  remote: { owner: string; repo: string } | undefined;
}

interface CliDependencies {
  githubFactory?: (token: string) => IssueMirror & ChangeRequestPublisher;
}

export async function runCli(argv = process.argv, dependencies: CliDependencies = {}): Promise<void> {
  const program = new Command();
  program.name("aiwf").description("afk-geoff orchestrator");

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
      console.log(`Initialized .ai-workflows in ${process.cwd()}`);
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
    .command("plan")
    .argument("<requirementId>", "Requirement id")
    .action(async (requirementId: string) => {
      const ctx = await openContext(process.cwd(), dependencies);
      const items = await planRequirement(ctx, requirementId);
      console.log(`Created ${items.length} draft work items for ${requirementId}`);
    });

  program
    .command("approve")
    .argument("<requirementId>", "Requirement id")
    .action(async (requirementId: string) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await autoSync(ctx);
      const items = await approveRequirement(ctx, requirementId);
      console.log(`Approved ${items.length} work items for ${requirementId}`);
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
    .command("dispatch")
    .option("--max <count>", "Maximum number of runnable AFK items", "1")
    .action(async (options: { max: string }) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await autoSync(ctx);
      const items = (await ctx.store.listWorkItems()).filter((item) => item.type === "afk" && item.status === "todo").slice(0, Number(options.max));

      for (const item of items) {
        await runWorkItem(ctx, item.id);
      }
    });

  program
    .command("run")
    .argument("<workItemId>", "Work item id")
    .action(async (workItemId: string) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await autoSync(ctx);
      await runWorkItem(ctx, workItemId);
    });

  program
    .command("review")
    .argument("<workItemId>", "HITL work item id")
    .action(async (workItemId: string) => {
      const ctx = await openContext(process.cwd(), dependencies);
      await autoSync(ctx);
      await prepareReview(ctx, workItemId);
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
  const github = config.github.enabled && process.env.GH_TOKEN
    ? dependencies.githubFactory
      ? dependencies.githubFactory(process.env.GH_TOKEN)
      : new GitHubMirror(process.env.GH_TOKEN)
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
    github,
    remote
  };
}

function createRunner(kind: "claude" | "codex"): AgentRunner {
  return kind === "claude" ? new ClaudeCliRunner() : new CodexCliRunner();
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
  const checks: Array<[string, string]> = [
    ["git", "git"],
    ["docker", "docker"],
    ["runner", ctx.runner.buildInvocation({ mode: "plan", promptPath: "/tmp/prompt.md", ...withCommandOverride(ctx.config.runner.command) }).command]
  ];

  if (ctx.config.github.enabled) {
    checks.push(["gh", "gh"]);
  }

  for (const [label, executable] of checks) {
    await assertCommandExists(executable, label);
  }

  for (const envVar of ctx.runner.requiredEnvVars(withRequiredEnv(ctx.config.runner.requiredEnv))) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required env var ${envVar}`);
    }
  }

  if (ctx.config.github.enabled && !ctx.remote) {
    throw new Error("GitHub is enabled but origin remote owner/repo could not be resolved.");
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

async function planRequirement(ctx: CliContext, requirementId: string): Promise<HydratedWorkItem[]> {
  const requirement = await mustGetRequirement(ctx, requirementId);
  const runDir = path.join(ctx.paths.runsDir, `plan-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });

  const outputPath = path.join(runDir, "plan.json");
  const promptPath = path.join(runDir, "prompt.md");
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  const overrideText = maybeReadOverride(ctx.repoRoot, ctx.config.prompts?.plan);
  const prompt = buildPlanPrompt({ requirement, outputPath, ...withText("overrideText", overrideText) });
  fs.writeFileSync(promptPath, prompt);

  const invocation = ctx.runner.buildInvocation({
    mode: "plan",
    promptPath,
    ...withCommandOverride(ctx.config.runner.command)
  });
  const exitCode = await runProcess(
    {
      command: invocation.command,
      args: invocation.args,
      cwd: ctx.repoRoot,
      env: allowedEnv(ctx.runner.requiredEnvVars(withRequiredEnv(ctx.config.runner.requiredEnv)))
    },
    { stdoutPath, stderrPath, mirrorToConsole: true }
  );

  if (exitCode !== 0 && !fs.existsSync(outputPath)) {
    throw new Error(`Planner command exited with ${exitCode}`);
  }

  const output = plannerOutputSchema.parse(JSON.parse(fs.readFileSync(outputPath, "utf8")));
  const items = await ctx.store.createDraftWorkItems(
    requirement.id,
    output.summary,
    output.items.map((item) => ({
      planKey: item.key,
      title: item.title,
      body: item.body,
      type: item.type,
      acceptanceCriteria: item.acceptanceCriteria,
      dependencyPlanKeys: item.dependsOnKeys
    }))
  );
  await ctx.store.updateRequirementStatus(requirement.id, "planned");
  return items;
}

async function approveRequirement(ctx: CliContext, requirementId: string): Promise<HydratedWorkItem[]> {
  const items = await ctx.store.listWorkItemsByRequirement(requirementId);
  const itemMap = new Map(items.map((item) => [item.id, item]));

  for (const item of items) {
    const nextStatus = initialApprovedStatus(item, itemMap);

    if (nextStatus !== item.status) {
      await ctx.store.updateWorkItemStatus(item.id, nextStatus);
    }
  }

  await refreshRequirementStatuses(ctx);
  await mirrorActionableWorkItems(ctx);
  return await ctx.store.listWorkItemsByRequirement(requirementId);
}

async function printStatus(ctx: CliContext): Promise<void> {
  const requirements = await ctx.store.listRequirements();
  const workItems = await ctx.store.listWorkItems();
  const runs = await ctx.store.listRuns();
  const prRefs = await ctx.store.listExternalRefs("work_item", "pull_request");
  const decisions = classifyWorkItems(workItems);

  console.log("Requirements");
  for (const requirement of requirements) {
    console.log(`- ${requirement.id}  ${requirement.title}  ${requirement.status}`);
  }
  console.log("");
  console.log("Runnable AFK items");
  for (const item of decisions.runnable) {
    console.log(`- ${item.id}  ${item.title}`);
  }
  console.log("");
  console.log("Blocked items");
  for (const item of decisions.blocked) {
    console.log(`- ${item.id}  ${item.title}`);
  }
  console.log("");
  console.log("HITL items");
  for (const item of decisions.hitl) {
    console.log(`- ${item.id}  ${item.title}`);
  }
  console.log("");
  console.log("Active runs / open PRs");
  for (const run of runs.filter((record) => record.status === "running" || record.status === "prepared")) {
    console.log(`- ${run.id}  ${run.workItemId}  ${run.status}`);
  }
  for (const ref of prRefs) {
    const workItem = workItems.find((item) => item.id === ref.entityId);
    if (workItem?.status !== "done") {
      console.log(`- PR #${ref.remoteNumber}  ${workItem?.title ?? ref.entityId}`);
    }
  }
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

async function runWorkItem(ctx: CliContext, workItemId: string): Promise<void> {
  const workItem = await mustGetWorkItem(ctx, workItemId);

  if (workItem.type !== "afk") {
    throw new Error(`Work item ${workItemId} is not AFK.`);
  }

  if (workItem.status !== "todo") {
    throw new Error(`Work item ${workItemId} is not runnable (current status: ${workItem.status}).`);
  }

  const requirement = await mustGetRequirement(ctx, workItem.requirementId);
  const runId = createId("run");
  const branchName = branchNameForWorkItem(workItem.title);
  const worktreePath = path.join(ctx.paths.worktreesDir, runId);
  const runDir = path.join(ctx.paths.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  await ctx.git.createWorktree({
    cwd: ctx.repoRoot,
    branchName,
    baseBranch: ctx.config.baseBranch,
    path: worktreePath
  });

  const runRecord = {
    id: runId,
    workItemId: workItem.id,
    mode: "work" as const,
    status: "running" as const,
    branchName,
    worktreePath,
    runDir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await ctx.store.createRun(runRecord);
  await ctx.store.updateWorkItemStatus(workItem.id, "in_progress");

  const resultPath = "/aiwf-run/result.json";
  const promptPath = path.join(runDir, "prompt.md");
  const manifestPath = path.join(runDir, "manifest.json");
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  const issueRef = await ctx.store.getExternalRefForEntity("work_item", workItem.id, "issue");
  const prompt = buildWorkerPrompt({
    requirement,
    workItem,
    verification: ctx.config.verification,
    resultPath,
    ...withText("issueUrl", issueRef?.url),
    ...withText("overrideText", maybeReadOverride(ctx.repoRoot, ctx.config.prompts?.worker))
  });
  fs.writeFileSync(promptPath, prompt);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        runId,
        workItemId: workItem.id,
        branchName,
        worktreePath
      },
      null,
      2
    )
  );

  const invocation = ctx.runner.buildInvocation({
    mode: "work",
    promptPath: "/aiwf-run/prompt.md",
    ...withCommandOverride(ctx.config.runner.command)
  });
  const dockerfilePath = ctx.config.docker.dockerfilePath
    ? path.resolve(ctx.repoRoot, ctx.config.docker.dockerfilePath)
    : DEFAULT_DOCKERFILE_PATH;
  const buildContext = ctx.config.docker.dockerfilePath ? ctx.repoRoot : path.dirname(DEFAULT_DOCKERFILE_PATH);
  await ctx.runtime.ensureImage({
    cwd: ctx.repoRoot,
    image: ctx.config.docker.image,
    dockerfilePath,
    buildContext
  });
  const exitCode = await ctx.runtime.runWork({
    image: ctx.config.docker.image,
    worktreePath,
    runDir,
    envAllowlist: ctx.config.runner.envAllowlist,
    command: invocation.command,
    args: invocation.args,
    stdoutPath,
    stderrPath
  });
  const hostResultPath = path.join(runDir, "result.json");

  if (!fs.existsSync(hostResultPath)) {
    await ctx.store.updateWorkItemStatus(workItem.id, "failed");
    await ctx.store.updateRun(runId, { status: "failed", summary: `No result.json found (exit code ${exitCode})` });
    throw new Error(`Worker did not produce result.json for ${workItem.id}`);
  }

  const result = workerResultSchema.parse(JSON.parse(fs.readFileSync(hostResultPath, "utf8")));

  if (ctx.github && ctx.remote && issueRef && result.issueComment.trim()) {
    await ctx.github.commentOnIssue({
      owner: ctx.remote.owner,
      repo: ctx.remote.repo,
      issueNumber: issueRef.remoteNumber,
      body: result.issueComment
    });
  }

  if (result.status === "blocked" || result.status === "failed") {
    await ctx.store.updateWorkItemStatus(workItem.id, result.status);
    await ctx.store.updateRun(runId, { status: result.status === "failed" ? "failed" : "completed", summary: result.summary });
    return;
  }

  await ctx.git.commitAll({
    cwd: worktreePath,
    message: `aiwf: ${workItem.title}`
  });

  const hasDiff = await ctx.git.hasDiffAgainst({
    cwd: worktreePath,
    baseBranch: ctx.config.baseBranch
  });

  if (!hasDiff) {
    await ctx.store.updateWorkItemStatus(workItem.id, "done");
    await ctx.store.updateRun(runId, { status: "completed", summary: result.summary });
    await refreshRequirementStatuses(ctx);
    return;
  }

  if (ctx.github && ctx.remote) {
    await ctx.git.pushBranch({ cwd: worktreePath, branchName });
    const prRef = await ctx.github.openPullRequest({
      owner: ctx.remote.owner,
      repo: ctx.remote.repo,
      changeRequest: {
        workItemId: workItem.id,
        branchName,
        baseBranch: ctx.config.baseBranch,
        title: result.pr?.title ?? `AIWF: ${workItem.title}`,
        body: result.pr?.body ?? result.summary
      }
    });
    await ctx.store.saveExternalRef(prRef);
    await ctx.store.updateRun(runId, { status: "completed", summary: result.summary });
    return;
  }

  await ctx.store.updateWorkItemStatus(workItem.id, "done");
  await ctx.store.updateRun(runId, { status: "completed", summary: result.summary });
  await refreshRequirementStatuses(ctx);
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

async function assertCommandExists(command: string, label: string): Promise<void> {
  try {
    await execFileAsync("which", [command]);
  } catch {
    throw new Error(`Missing ${label} executable: ${command}`);
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

function initialApprovedStatus(item: HydratedWorkItem, itemMap: Map<string, HydratedWorkItem>): WorkItemStatus {
  if (item.type === "hitl") {
    return "hitl_pending";
  }

  const blocked = item.dependencyIds.some((dependencyId) => {
    const dependency = itemMap.get(dependencyId);
    return dependency?.status !== "done";
  });

  return blocked ? "blocked" : "todo";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
