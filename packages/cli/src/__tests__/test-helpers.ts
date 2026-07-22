import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { vi } from "vitest";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { ChangeRequest, ChangeRequestPublisher, ExternalRef, IssueMirror, PullRequestReviewSource, Requirement, WorkItem, WorkSource, WorkflowArtifactSource, WorkflowDispatcher, WorkflowRunSource } from "@afk-geoff/core";
import { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";
import { runCli } from "../index.js";

export interface FixtureOptions {
  githubEnabled?: boolean;
  writeWorktreeChange?: boolean;
  runnerScriptSuffix?: string;
  githubMirror?: MockGitHubMirror;
  githubIssueWorkSource?: WorkSource<string>;
  githubTokenResolver?: () => Promise<string | undefined>;
  /** Override the detach launcher so tests can control background spawning. */
  detachLauncher?: (argv: string[], env: NodeJS.ProcessEnv, cwd: string) => { pid: number };
  /** Override the watch poll interval (milliseconds) for testing. */
  watchPollIntervalMs?: number;
  /** Hook called after each watch poll iteration to let tests mutate state. */
  onAfterPoll?: () => Promise<void>;
  /** Override git remote reachability check for preflight. Defaults to no-op (local bare remote is always accessible in tests). */
  gitRemoteChecker?: (repoRoot: string) => Promise<void>;
  /** Override GitHub auth verification for preflight. Defaults to no-op (tests use mock GitHub). */
  githubAuthVerifier?: (token: string, remote: { owner: string; repo: string }) => Promise<void>;
}

export interface WorkflowFixture {
  repoDir: string;
  store: SqliteStateStore;
  githubMirror: MockGitHubMirror | undefined;
  cli(args: string[]): Promise<void>;
  capture(prompt: string): Promise<Requirement>;
  requirement(): Promise<Requirement>;
  items(requirementId: string): Promise<Awaited<ReturnType<SqliteStateStore["listWorkItemsByRequirement"]>>>;
  seedQueue(requirementId: string): Promise<Awaited<ReturnType<SqliteStateStore["listWorkItemsByRequirement"]>>>;
}

export async function createFixture(tempDir: string, options: FixtureOptions = {}): Promise<WorkflowFixture> {
  const repoDir = path.join(tempDir, "repo");
  const fakeBinDir = path.join(tempDir, "bin");
  const remoteDir = path.join(tempDir, "remote.git");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });

  writeFakeDocker(fakeBinDir);
  writeRepoFiles(repoDir, options.writeWorktreeChange ?? true, options.runnerScriptSuffix);
  process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;

  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

  if (options.githubEnabled) {
    execFileSync("git", ["init", "--bare", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
  }

  process.chdir(repoDir);

  // Always inject a no-op GitHub auth verifier so tests never make real API calls.
  // When a specific verifier is provided in options it overrides this default.
  const dependencies = {
    ...(options.githubMirror ? { githubFactory: () => options.githubMirror as IssueMirror & ChangeRequestPublisher } : {}),
    ...(options.githubIssueWorkSource ? { githubIssueWorkSourceFactory: () => options.githubIssueWorkSource as WorkSource<string> } : {}),
    ...(options.githubTokenResolver ? { githubTokenResolver: options.githubTokenResolver } : {}),
    ...(options.detachLauncher ? { detachLauncher: options.detachLauncher } : {}),
    ...(options.watchPollIntervalMs !== undefined ? { watchPollIntervalMs: options.watchPollIntervalMs } : {}),
    ...(options.onAfterPoll ? { onAfterPoll: options.onAfterPoll } : {}),
    ...(options.gitRemoteChecker !== undefined ? { gitRemoteChecker: options.gitRemoteChecker } : {}),
    // Default: no-op so tests never make real GitHub API calls; override explicitly for auth-failure tests.
    githubAuthVerifier: options.githubAuthVerifier ?? (async () => {})
  };

  await runCli(["node", "afk", "init"], dependencies);
  rewriteConfig(repoDir, { githubEnabled: options.githubEnabled ?? false });

  if (options.githubEnabled || options.githubIssueWorkSource) {
    process.env.GH_TOKEN = "test-token";
  }

  const config = loadProjectConfig(repoDir);
  const paths = resolveProjectPaths(repoDir, config);
  const store = new SqliteStateStore(paths.statePath);

  return {
    repoDir,
    store,
    githubMirror: options.githubMirror,
    cli: async (args: string[]) => {
      await runCli(["node", "afk", ...args], dependencies ?? {});
    },
    capture: async (prompt: string) => {
      await runCli(["node", "afk", "capture", prompt], dependencies ?? {});
      return await firstRequirement(store);
    },
    requirement: async () => firstRequirement(store),
    items: async (requirementId: string) => store.listWorkItemsByRequirement(requirementId),
    seedQueue: async (requirementId: string) => {
      const seeded = await store.createDraftWorkItems(requirementId, "Seeded queue", createSeedWorkItems());
      const backend = seeded.find((item) => item.planKey === "backend");
      const frontend = seeded.find((item) => item.planKey === "frontend");
      const review = seeded.find((item) => item.planKey === "review");

      if (!backend || !frontend || !review) {
        throw new Error("Expected seeded queue items to exist");
      }

      await store.updateRequirementStatus(requirementId, "approved");
      await store.updateWorkItemStatus(backend.id, "todo");
      await store.updateWorkItemStatus(frontend.id, "blocked");
      await store.updateWorkItemStatus(review.id, "hitl_pending");
      await runCli(["node", "afk", "sync"], dependencies);
      return await store.listWorkItemsByRequirement(requirementId);
    }
  };
}

export async function firstRequirement(store: SqliteStateStore): Promise<Requirement> {
  const [requirement] = await store.listRequirements();

  if (!requirement) {
    throw new Error("Expected a requirement to exist");
  }

  return requirement;
}

export function rewriteConfig(repoDir: string, options: { githubEnabled: boolean; runnerRequiredEnv?: string[]; runnerCommand?: string[]; runnerModel?: string; runnerReviewModel?: string; timeouts?: { runTimeoutMs?: number; heartbeatStaleMs?: number } }): void {
  const configPath = path.join(repoDir, ".afk", "config.yaml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
  config.github.enabled = options.githubEnabled;
  config.github.owner = options.githubEnabled ? "acme" : undefined;
  config.github.repo = options.githubEnabled ? "demo" : undefined;
  config.runner.command = options.runnerCommand ?? ["node", "fake-runner.mjs", "{prompt}"];
  config.runner.requiredEnv = options.runnerRequiredEnv ?? [];
  config.runner.envAllowlist = [];
  if (options.runnerModel !== undefined) {
    config.runner.model = options.runnerModel;
  }
  if (options.runnerReviewModel !== undefined) {
    config.runner.review = { model: options.runnerReviewModel };
  }
  config.verification = [];
  if (options.timeouts) {
    config.timeouts = options.timeouts;
  }
  fs.writeFileSync(configPath, YAML.stringify(config));
}

export function createSeedWorkItems(): Array<{
  planKey: string;
  title: string;
  body: string;
  type: "afk" | "hitl";
  acceptanceCriteria: string[];
  dependencyPlanKeys: string[];
}> {
  return [
    {
      planKey: "backend",
      title: "Implement backend queue",
      body: "Create the backend processing flow.",
      type: "afk",
      acceptanceCriteria: ["Backend queue exists"],
      dependencyPlanKeys: []
    },
    {
      planKey: "frontend",
      title: "Wire frontend state",
      body: "Hook the UI into the backend queue.",
      type: "afk",
      acceptanceCriteria: ["UI uses backend queue"],
      dependencyPlanKeys: ["backend"]
    },
    {
      planKey: "review",
      title: "Review UX copy",
      body: "Human must confirm the UX wording.",
      type: "hitl",
      acceptanceCriteria: ["Copy decision recorded"],
      dependencyPlanKeys: []
    }
  ];
}

export function writeRepoFiles(repoDir: string, writeWorktreeChange: boolean, runnerScriptSuffix?: string): void {
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2));
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Fixture\n");
  fs.writeFileSync(
    path.join(repoDir, "fake-runner.mjs"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const promptPath = process.argv.at(-1);
const prompt = fs.readFileSync(promptPath, "utf8");

// Handle autonomous review prompts: the review prompt uses a distinct marker.
const reviewMatch = prompt.match(/Write your review verdict JSON to this exact path:\\n([^\\n]+)/);
if (reviewMatch) {
  const reviewOutputPath = reviewMatch[1].trim();
  // Read per-test review control file for verdicts queue.
  // Use the env var path first (set by writeReviewVerdicts), fallback to cwd.
  const controlFilePath = process.env.AFK_TEST_REVIEW_VERDICTS_PATH ?? path.join(process.cwd(), ".afk-test-review-verdicts");
  let verdict = "PASS";
  let issues = [];
  let blockerReason = undefined;
  if (fs.existsSync(controlFilePath)) {
    try {
      const rawContent = fs.readFileSync(controlFilePath, "utf8").trim();
      const verdicts = rawContent ? JSON.parse(rawContent) : [];
      if (Array.isArray(verdicts) && verdicts.length > 0) {
        const nextVerdict = verdicts[0];
        if (typeof nextVerdict === "string") {
          verdict = nextVerdict;
        } else if (nextVerdict && typeof nextVerdict === "object") {
          verdict = nextVerdict.verdict ?? "PASS";
          issues = nextVerdict.issues ?? [];
          blockerReason = nextVerdict.blockerReason;
        }
        // Advance the queue.
        fs.writeFileSync(controlFilePath, JSON.stringify(verdicts.slice(1)));
      }
    } catch {
      // ignore control file errors; default to PASS
    }
  }
  // Special sentinel: produce deliberately malformed JSON so the backend fails gracefully.
  if (verdict === "__MALFORMED__") {
    fs.writeFileSync(reviewOutputPath, "{ verdict: PASS "); // missing closing brace + unquoted key
    process.exit(0);
  }
  const result = { verdict, ...(issues.length > 0 ? { issues } : {}), ...(blockerReason ? { blockerReason } : {}) };
  fs.writeFileSync(reviewOutputPath, JSON.stringify(result, null, 2));
  process.exit(0);
}

const match = prompt.match(/Write a JSON file to this exact path(?: when you are done)?:\\n([^\\n]+)/);
if (!match) {
  throw new Error("Missing output marker");
}
const outputPath = match[1].trim();

if (prompt.includes('"items": [')) {
  fs.writeFileSync(outputPath, JSON.stringify({
    summary: "Planned work items",
    items: [
      {
        key: "backend",
        title: "Implement backend queue",
        body: "Create the backend processing flow.",
        type: "afk",
        acceptanceCriteria: ["Backend queue exists"],
        dependsOnKeys: []
      },
      {
        key: "frontend",
        title: "Wire frontend state",
        body: "Hook the UI into the backend queue.",
        type: "afk",
        acceptanceCriteria: ["UI uses backend queue"],
        dependsOnKeys: ["backend"]
      },
      {
        key: "review",
        title: "Review UX copy",
        body: "Human must confirm the UX wording.",
        type: "hitl",
        acceptanceCriteria: ["Copy decision recorded"],
        dependsOnKeys: []
      }
    ]
  }, null, 2));
  process.exit(0);
}

${writeWorktreeChange ? 'fs.writeFileSync(path.join(process.cwd(), "implemented.txt"), "done\\\\n");' : ""}
${runnerScriptSuffix ?? ""}
fs.writeFileSync(outputPath, JSON.stringify({
  status: "done",
  summary: "Completed work item",
  issueComment: "Finished the AFK work item.",
  pr: {
    title: "AFK: complete work item",
    body: "Done"
  }
}, null, 2));
`
  );
}

export function writeFakeDocker(fakeBinDir: string): void {
  const dockerPath = path.join(fakeBinDir, "docker");
  fs.writeFileSync(
    dockerPath,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "image" && args[1] === "inspect") {
  process.exit(1);
}
  if (args[0] === "build") {
  process.exit(0);
}
if (args[0] !== "run") {
  process.exit(0);
}

let worktree = process.cwd();
const mounts = new Map();
let workdir = process.cwd();
let index = 1;
while (index < args.length) {
  if (args[index] === "--rm") {
    index += 1;
    continue;
  }
  if (args[index] === "--user") {
    index += 2;
    continue;
  }
  if (args[index] === "--name") {
    index += 2;
    continue;
  }
  if (args[index] === "-w") {
    workdir = args[index + 1];
    index += 2;
    continue;
  }
  if (args[index] === "-v") {
    const [host, container] = args[index + 1].split(":");
    mounts.set(container, host);
    if (container === "/workspace") {
      worktree = host;
    }
    index += 2;
    continue;
  }
  if (args[index] === "-e") {
    index += 2;
    continue;
  }
  break;
}

for (const [container, host] of mounts.entries()) {
  if (workdir.startsWith(container)) {
    worktree = workdir.replace(container, host);
    break;
  }
}

if (process.env.AFK_TEST_BREAK_WORKTREE_GIT === "1") {
  const expectedGitDir = path.resolve(worktree, "..", "..", "..", ".git");
  const hasRealWorktreeMount = mounts.has(worktree);
  const hasSharedGitMount = mounts.has(expectedGitDir);

  if (!hasRealWorktreeMount || !hasSharedGitMount || workdir !== worktree) {
    const worktreeGitPath = path.join(worktree, ".git");
    if (fs.existsSync(worktreeGitPath) && fs.lstatSync(worktreeGitPath).isFile()) {
      fs.unlinkSync(worktreeGitPath);
      spawnSync("git", ["init"], { cwd: worktree, stdio: "inherit" });
      spawnSync("git", ["config", "user.email", "agent@afk"], { cwd: worktree, stdio: "inherit" });
      spawnSync("git", ["config", "user.name", "AFK Agent"], { cwd: worktree, stdio: "inherit" });
    }
  }
}

index += 1;
const command = args[index];
let commandArgs = args.slice(index + 1).map((value) => {
  let rewritten = value;
  for (const [container, host] of mounts.entries()) {
    rewritten = rewritten.split(container).join(host);
  }
  return rewritten;
});

const promptPaths = new Set();
for (const value of commandArgs) {
  const matches = value.match(/\\/[A-Za-z0-9._\\/-]+\\.md/g) ?? [];
  for (const promptPath of matches) {
    promptPaths.add(promptPath);
  }
}

const rewrittenPromptPaths = new Map();
for (const promptPath of promptPaths) {
  if (!fs.existsSync(promptPath)) {
    continue;
  }
  let prompt = fs.readFileSync(promptPath, "utf8");
  for (const [container, host] of mounts.entries()) {
    prompt = prompt.split(container).join(host);
  }
  const rewrittenPromptPath = path.join(os.tmpdir(), \`afk-prompt-\${process.pid}-\${Date.now()}-\${Math.random().toString(16).slice(2)}.md\`);
  fs.writeFileSync(rewrittenPromptPath, prompt);
  rewrittenPromptPaths.set(promptPath, rewrittenPromptPath);
}

if (rewrittenPromptPaths.size > 0) {
  commandArgs = commandArgs.map((value) => {
    let rewritten = value;
    for (const [originalPromptPath, rewrittenPromptPath] of rewrittenPromptPaths.entries()) {
      rewritten = rewritten.split(originalPromptPath).join(rewrittenPromptPath);
    }
    return rewritten;
  });
}

const result = spawnSync(command, commandArgs, {
  cwd: worktree,
  stdio: "inherit"
});
process.exit(result.status ?? 1);
`
  );
  fs.chmodSync(dockerPath, 0o755);
}

export function processExistsForTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!processExistsForTest(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export class MockGitHubMirror implements IssueMirror, ChangeRequestPublisher, PullRequestReviewSource, WorkflowArtifactSource, WorkflowDispatcher, WorkflowRunSource {
  public readonly requirementMirrorIds: string[] = [];
  public readonly workItemMirrorIds: string[] = [];
  public readonly pullRequestRequests: ChangeRequest[] = [];
  public readonly closedPullRequestNumbers: number[] = [];
  public readonly issueComments: Array<{ issueNumber: number; body: string }> = [];
  public readonly workflowDispatches: Array<{ owner: string; repo: string; workflowId: string; ref: string; inputs: Record<string, string> }> = [];
  public workflowRuns: Array<{ id: string; name?: string; status?: string; conclusion?: string; branch?: string; event?: string; url?: string; createdAt?: string; updatedAt?: string }> = [];
  public workflowArtifacts: Array<{ id: string; name: string; sizeInBytes?: number; expired?: boolean; url?: string; archiveDownloadUrl?: string; createdAt?: string; updatedAt?: string; expiresAt?: string }> = [];
  public workflowArtifactBytes = new Uint8Array(Buffer.from("zip-bytes"));
  public reviewComments: Array<{ id: string; body: string; path?: string; line?: number }> = [];
  public openPullRequestError: Error | undefined;
  private readonly pullRequestStates = new Map<number, { state: "open" | "closed"; merged: boolean }>();

  public async mirrorRequirement(input: { owner: string; repo: string; requirement: Requirement }): Promise<ExternalRef> {
    this.requirementMirrorIds.push(input.requirement.id);
    return createRef("requirement", input.requirement.id, "issue", this.requirementMirrorIds.length);
  }

  public async mirrorWorkItem(input: { owner: string; repo: string; workItem: WorkItem; requirement: Requirement }): Promise<ExternalRef> {
    this.workItemMirrorIds.push(input.workItem.id);
    return createRef("work_item", input.workItem.id, "issue", this.workItemMirrorIds.length + 100);
  }

  public async commentOnIssue(input: { owner: string; repo: string; issueNumber: number; body: string }): Promise<void> {
    this.issueComments.push({ issueNumber: input.issueNumber, body: input.body });
  }

  public async syncIssues(): Promise<Array<{ refId: string; open: boolean; comments: Array<{ id: string; body: string; createdAt: string }> }>> {
    return [];
  }

  public async openPullRequest(input: { owner: string; repo: string; changeRequest: ChangeRequest }): Promise<ExternalRef> {
    if (this.openPullRequestError) {
      throw this.openPullRequestError;
    }
    this.pullRequestRequests.push(input.changeRequest);
    const ref = createRef("work_item", input.changeRequest.workItemId, "pull_request", this.pullRequestRequests.length + 200);
    this.pullRequestStates.set(ref.remoteNumber, { state: "open", merged: false });
    return ref;
  }

  public async closePullRequest(input: { owner: string; repo: string; pullNumber: number }): Promise<void> {
    this.closedPullRequestNumbers.push(input.pullNumber);
    this.pullRequestStates.set(input.pullNumber, { state: "closed", merged: false });
  }

  public async syncPullRequests(input: { owner: string; repo: string; refs: ExternalRef[] }): Promise<Array<{ refId: string; state: "open" | "closed"; merged: boolean }>> {
    return input.refs.map((ref) => ({
      refId: ref.id,
      ...(this.pullRequestStates.get(ref.remoteNumber) ?? { state: "open", merged: false })
    }));
  }

  public async listPullRequestReviewComments(): Promise<Array<{ id: string; body: string; path?: string; line?: number }>> {
    return this.reviewComments;
  }

  public async dispatchWorkflow(input: { owner: string; repo: string; workflowId: string; ref: string; inputs: Record<string, string> }): Promise<void> {
    this.workflowDispatches.push(input);
  }

  public async listWorkflowRuns(input: { owner: string; repo: string; workflowId: string; limit: number }): Promise<Array<{ id: string; name?: string; status?: string; conclusion?: string; branch?: string; event?: string; url?: string; createdAt?: string; updatedAt?: string }>> {
    return this.workflowRuns.slice(0, input.limit);
  }

  public async listWorkflowArtifacts(input: { owner: string; repo: string; runId: string; limit: number }): Promise<Array<{ id: string; name: string; sizeInBytes?: number; expired?: boolean; url?: string; archiveDownloadUrl?: string; createdAt?: string; updatedAt?: string; expiresAt?: string }>> {
    return this.workflowArtifacts.slice(0, input.limit);
  }

  public async downloadWorkflowArtifact(): Promise<Uint8Array> {
    return this.workflowArtifactBytes;
  }
}

export function createRef(
  entityType: ExternalRef["entityType"],
  entityId: string,
  remoteType: ExternalRef["remoteType"],
  remoteNumber: number
): ExternalRef {
  const now = new Date().toISOString();
  return {
    id: `xref_${entityId}_${remoteType}_${remoteNumber}`,
    entityType,
    entityId,
    provider: "github",
    remoteType,
    remoteNumber,
    remoteId: String(remoteNumber),
    url: `https://example.com/${remoteType}/${remoteNumber}`,
    createdAt: now,
    updatedAt: now
  };
}

export async function captureConsole(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });

  try {
    await action();
  } finally {
    logSpy.mockRestore();
  }

  return lines.join("\n");
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "afk-"));
}

/**
 * Write a queue of review verdicts that the fake runner will consume in order.
 * Each entry can be a string ("PASS", "ISSUES", "BLOCKED") or an object with
 * { verdict, issues?, blockerReason? }.
 * After all verdicts are consumed, the fake runner defaults to "PASS".
 *
 * Also sets AFK_TEST_REVIEW_VERDICTS_PATH so the fake runner can find the file
 * regardless of cwd (review agents run directly with cwd=worktreePath which is
 * a separate git worktree, not the repoDir).
 */
export function writeReviewVerdicts(
  repoDir: string,
  verdicts: Array<string | { verdict: string; issues?: string[]; blockerReason?: string }>
): void {
  const controlFilePath = path.join(repoDir, ".afk-test-review-verdicts");
  fs.writeFileSync(controlFilePath, JSON.stringify(verdicts));
  process.env.AFK_TEST_REVIEW_VERDICTS_PATH = controlFilePath;
}
